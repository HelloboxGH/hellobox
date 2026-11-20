import { describe, expect, test } from "bun:test";
import { AppError, forbidden } from "nezt";
import { normalizeScopes } from "@/core/agent-scopes";
import { currentAgent } from "./context";
import { type AgentAuditEntry, type AgentTokenRow, createAgentEndpoint } from "./server";
import { agentTokenProblem, generateAgentToken, hashAgentToken, looksLikeAgentToken } from "./tokens";
import { type AgentActions, htmlToText, replyRecipients, textToHtml } from "./tools";

const DAY = 24 * 60 * 60 * 1000;
const PROTOCOL = "2026-07-28";

function tokenRow(token: string, overrides: Partial<AgentTokenRow> = {}): AgentTokenRow {
  return {
    id: "tok_1",
    name: "Claude",
    userId: "user_1",
    workspaceId: "ws_1",
    scopes: ["read", "write", "send"],
    expiresAt: new Date(Date.now() + 30 * DAY),
    revokedAt: null,
    ...overrides,
  };
}

const message = (overrides: Record<string, unknown> = {}) => ({
  id: "msg_1",
  direction: "inbound",
  fromAddress: "ada@example.com",
  fromName: "Ada",
  toRecipients: [{ address: "support@acme.test" }, { address: "grace@example.com" }],
  ccRecipients: [{ address: "linus@example.com" }],
  replyTo: [],
  subject: "Invoice",
  sentAt: new Date("2026-11-01T10:00:00Z"),
  textBody: "Where's my invoice?",
  htmlBody: null,
  attachments: [],
  deliveryStatus: null,
  agentTokenId: null,
  ...overrides,
});

// Records every action call, with the agent the middlewares would see.
function fakeActions(overrides: Partial<Record<keyof AgentActions, (input: never) => unknown>> = {}) {
  const calls: { path: string; input: unknown; agent: string | undefined }[] = [];
  const defaults: Partial<Record<keyof AgentActions, (input: never) => unknown>> = {
    "/app/bootstrap": () => ({
      user: { name: "Sam", email: "sam@acme.test" },
      workspace: { id: "ws_1", name: "Acme", plan: "solo" },
      role: "member",
      mailboxes: [{ id: "mb_1", address: "support@acme.test", displayName: "Acme" }],
      labels: [],
      counts: { inboxUnread: 0, spam: 0, starred: 0 },
    }),
    "/threads/get": () => ({
      thread: { id: "th_1", subject: "Invoice", mailboxId: "mb_1", folder: "inbox" },
      starred: false,
      labels: [],
      notes: [],
      messages: [message()],
    }),
    "/mail/send": () => ({ id: "out_1", sendAt: new Date() }),
    "/threads/update": (input: { ids: string[] }) => ({ updated: input.ids.length }),
  };
  const merged = { ...defaults, ...overrides };
  const actions = new Proxy({} as AgentActions, {
    get: (_target, path: string) => async (input: unknown) => {
      calls.push({ path, input, agent: currentAgent()?.tokenId });
      const run = merged[path as keyof AgentActions];
      if (!run) throw new Error(`Unexpected action ${path}`);
      return run(input as never);
    },
  });
  return { actions, calls };
}

function setup(options: { row?: Partial<AgentTokenRow>; actions?: ReturnType<typeof fakeActions> } = {}) {
  const { token, hash } = generateAgentToken();
  const row = tokenRow(token, options.row);
  const fake = options.actions ?? fakeActions();
  const audits: AgentAuditEntry[] = [];
  const touched: string[] = [];
  const serve = createAgentEndpoint({
    lookup: {
      findByHash: async (candidate) => (candidate === hash ? row : undefined),
      touch: async (id) => touched.push(id),
    },
    actions: fake.actions,
    audit: async (entry) => audits.push(entry),
    allowedOrigins: () => ["hellobox.app"],
  });
  return { token, serve, audits, touched, ...fake };
}

let nextId = 1;
function rpc(method: string, params: Record<string, unknown> = {}, init: { token?: string; origin?: string } = {}) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": PROTOCOL,
    "mcp-method": method,
  };
  if (method === "tools/call") headers["mcp-name"] = String(params.name);
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.origin) headers.origin = init.origin;
  const meta = {
    "io.modelcontextprotocol/protocolVersion": PROTOCOL,
    "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
  return new Request("https://hellobox.app/api/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params: { ...params, _meta: meta } }),
  });
}

async function listTools(serve: (request: Request) => Promise<Response>, token: string) {
  const response = await serve(rpc("tools/list", {}, { token }));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { result: { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] } };
  return body.result.tools;
}

async function callTool(
  serve: (request: Request) => Promise<Response>,
  token: string,
  name: string,
  args: Record<string, unknown>,
) {
  const response = await serve(rpc("tools/call", { name, arguments: args }, { token }));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { result: { isError?: boolean; content: { text: string }[] } };
  return { isError: body.result.isError ?? false, data: JSON.parse(body.result.content[0]?.text ?? "null") };
}

describe("agent tokens", () => {
  test("are random, prefixed and stored only as a hash", () => {
    const first = generateAgentToken();
    const second = generateAgentToken();
    expect(first.token).not.toBe(second.token);
    expect(looksLikeAgentToken(first.token)).toBe(true);
    expect(first.hash).toBe(hashAgentToken(first.token));
    expect(first.hash).not.toContain(first.token);
    expect(first.hint).toBe(first.token.slice(-4));
  });

  test("reject strings that were never tokens", () => {
    expect(looksLikeAgentToken("rbx_agent_short")).toBe(false);
    expect(looksLikeAgentToken(`sk_live_${"a".repeat(43)}`)).toBe(false);
  });

  test("stop working once revoked or expired", () => {
    const now = new Date("2026-11-07T12:00:00Z");
    expect(agentTokenProblem({ revokedAt: null, expiresAt: new Date(now.getTime() + DAY) }, now)).toBeNull();
    expect(agentTokenProblem({ revokedAt: now, expiresAt: new Date(now.getTime() + DAY) }, now)).toBe("revoked");
    expect(agentTokenProblem({ revokedAt: null, expiresAt: now }, now)).toBe("expired");
  });

  test("scopes build on each other", () => {
    expect(normalizeScopes(["send"])).toEqual(["read", "write", "send"]);
    expect(normalizeScopes(["write"])).toEqual(["read", "write"]);
    expect(normalizeScopes([])).toEqual(["read"]);
  });
});

describe("the MCP endpoint", () => {
  test("refuses requests without a valid token", async () => {
    const { serve, token } = setup();
    const missing = await serve(rpc("tools/list"));
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain("Bearer");
    expect((await serve(rpc("tools/list", {}, { token: generateAgentToken().token }))).status).toBe(401);
    expect((await serve(rpc("tools/list", {}, { token: `${token}x` }))).status).toBe(401);
  });

  test("refuses revoked and expired tokens", async () => {
    const revoked = setup({ row: { revokedAt: new Date() } });
    expect((await revoked.serve(rpc("tools/list", {}, { token: revoked.token }))).status).toBe(401);
    const expired = setup({ row: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await expired.serve(rpc("tools/list", {}, { token: expired.token }))).status).toBe(401);
  });

  test("refuses browsers on other sites", async () => {
    const { serve, token } = setup();
    expect((await serve(rpc("tools/list", {}, { token, origin: "https://evil.example" }))).status).toBe(403);
    expect((await serve(rpc("tools/list", {}, { token, origin: "https://hellobox.app" }))).status).toBe(200);
  });

  test("still serves clients on the 2025 protocol", async () => {
    const { serve, token } = setup({ row: { scopes: ["read"] } });
    const legacy = (body: Record<string, unknown>) =>
      new Request("https://hellobox.app/api/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
          "mcp-protocol-version": "2025-11-25",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, ...body }),
      });
    const init = await serve(
      legacy({
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "old", version: "1" } },
      }),
    );
    expect(init.status).toBe(200);
    const listed = await serve(legacy({ method: "tools/list", params: {} }));
    expect(listed.status).toBe(200);
    expect(await listed.text()).toContain("list_threads");
  });

  test("records when a token was used", async () => {
    const { serve, token, touched } = setup();
    await serve(rpc("tools/list", {}, { token }));
    expect(touched).toEqual(["tok_1"]);
  });
});

describe("scoping", () => {
  test("a read-only connection only sees read-only tools", async () => {
    const { serve, token } = setup({ row: { scopes: ["read"] } });
    const tools = await listTools(serve, token);
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("list_threads");
    expect(names).toContain("get_thread");
    expect(names).not.toContain("move_threads");
    expect(names).not.toContain("send_email");
    expect(names).not.toContain("send_campaign");
    expect(tools.every((tool) => tool.annotations?.readOnlyHint)).toBe(true);
  });

  test("a write connection can organize but not send", async () => {
    const { serve, token } = setup({ row: { scopes: ["read", "write"] } });
    const names = (await listTools(serve, token)).map((tool) => tool.name);
    expect(names).toContain("move_threads");
    expect(names).toContain("save_draft");
    expect(names).not.toContain("reply");
  });

  test("calling a tool outside the connection's scopes does nothing", async () => {
    const fake = fakeActions();
    const { serve, token } = setup({ row: { scopes: ["read"] }, actions: fake });
    const response = await serve(rpc("tools/call", { name: "send_email", arguments: { mailboxId: "mb_1", to: ["a@b.co"] } }, { token }));
    const body = (await response.json()) as { result?: { isError?: boolean }; error?: unknown };
    expect(body.error ?? body.result?.isError).toBeTruthy();
    expect(fake.calls).toEqual([]);
  });
});

describe("tools", () => {
  test("run the app's actions as the token's agent", async () => {
    const { serve, token, calls, audits } = setup();
    const result = await callTool(serve, token, "move_threads", { threadIds: ["th_1", "th_2"], folder: "archive" });
    expect(result).toEqual({ isError: false, data: { updated: 2 } });
    expect(calls).toEqual([{ path: "/threads/update", input: { ids: ["th_1", "th_2"], folder: "archive" }, agent: "tok_1" }]);
    expect(audits).toEqual([expect.objectContaining({ tool: "move_threads", target: "th_1,th_2" })]);
  });

  test("reads aren't written to the audit log", async () => {
    const { serve, token, audits } = setup();
    const result = await callTool(serve, token, "get_thread", { threadId: "th_1" });
    expect(result.data.messages[0]).toMatchObject({ from: "Ada <ada@example.com>", text: "Where's my invoice?", sentByAgent: false });
    expect(audits).toEqual([]);
  });

  test("reply fills in recipients like the app's Reply all", async () => {
    const { serve, token, calls } = setup();
    const result = await callTool(serve, token, "reply", { threadId: "th_1", replyAll: true, text: "Sent it.\n\nThanks" });
    expect(result.isError).toBe(false);
    const send = calls.find((call) => call.path === "/mail/send");
    expect(send?.input).toMatchObject({
      mailboxId: "mb_1",
      threadId: "th_1",
      replyToMessageId: "msg_1",
      to: ["ada@example.com"],
      cc: ["grace@example.com", "linus@example.com"],
      subject: "Re: Invoice",
      html: "<p>Sent it.</p><p>Thanks</p>",
    });
  });

  test("add_domain uses the workspace's only SES connection", async () => {
    const fake = fakeActions({
      "/app/bootstrap": () => ({ connections: [{ id: "conn_ses", provider: "ses", status: "active" }, { id: "conn_resend", provider: "resend", status: "active" }] }),
      "/connections/domains/add": () => ({ records: [], applied: [], skipped: [], appliedTo: null }),
    });
    const { serve, token, audits } = setup({ actions: fake });
    const result = await callTool(serve, token, "add_domain", { domain: "acme.com" });
    expect(result.isError).toBe(false);
    expect(fake.calls.at(-1)).toMatchObject({ path: "/connections/domains/add", input: { connectionId: "conn_ses", domain: "acme.com" } });
    expect(audits).toEqual([expect.objectContaining({ tool: "add_domain", target: "acme.com" })]);
  });

  test("add_domain asks which connection when there are several", async () => {
    const fake = fakeActions({
      "/app/bootstrap": () => ({ connections: [{ id: "a", provider: "ses", status: "active" }, { id: "b", provider: "ses", status: "active" }] }),
    });
    const { serve, token } = setup({ actions: fake });
    const result = await callTool(serve, token, "add_domain", { domain: "acme.com" });
    expect(result.isError).toBe(true);
    expect(result.data.message).toContain("connectionId");
    expect(fake.calls.map((call) => call.path)).toEqual(["/app/bootstrap"]);
  });

  test("remove_domain removes by id and is audited", async () => {
    const fake = fakeActions({ "/domains/remove": () => ({ ok: true, movedTo: null, mailboxesMoved: 0 }) });
    const { serve, token, audits } = setup({ actions: fake });
    const result = await callTool(serve, token, "remove_domain", { id: "dom_1" });
    expect(result.isError).toBe(false);
    expect(fake.calls.at(-1)).toMatchObject({ path: "/domains/remove", input: { id: "dom_1" } });
    expect(audits).toEqual([expect.objectContaining({ tool: "remove_domain", target: "dom_1" })]);
  });

  test("list_domains leaves out removed domains and gives their ids", async () => {
    const fake = fakeActions({
      "/app/bootstrap": () => ({
        connections: [{ id: "conn_ses", provider: "ses", status: "active", region: "us-east-1" }],
        domains: [
          { id: "dom_1", name: "acme.com", connectionId: "conn_ses", status: "verified", enabled: true, sendingEnabled: true, receivingEnabled: true, removedAt: null },
          { id: "dom_2", name: "old.com", connectionId: "conn_ses", status: "verified", enabled: false, sendingEnabled: true, receivingEnabled: false, removedAt: "2026-11-01T00:00:00Z" },
        ],
      }),
    });
    const { serve, token } = setup({ actions: fake });
    const result = await callTool(serve, token, "list_domains", {});
    expect(result.data.domains).toEqual([expect.objectContaining({ id: "dom_1", name: "acme.com", provider: "ses" })]);
  });

  test("billing errors come back as tool errors that say what to do", async () => {
    const fake = fakeActions({
      "/threads/update": () => {
        // The shape cloud's billing slot throws for a refused feature.
        throw new AppError("Assigning conversations needs the Team plan", "PLAN_REQUIRED", 402, { requiredPlan: "team", featureName: "assignments" });
      },
    });
    const { serve, token, audits } = setup({ actions: fake });
    const result = await callTool(serve, token, "mark_threads", { threadIds: ["th_1"], read: true });
    expect(result.isError).toBe(true);
    expect(result.data.code).toBe("PLAN_REQUIRED");
    expect(result.data.message).toContain("Team plan");
    expect(result.data.message).toContain("/settings?tab=billing");
    expect(audits).toEqual([]);
  });

  test("permission errors from the app's checks reach the agent unchanged", async () => {
    const fake = fakeActions({
      "/threads/get": () => {
        throw forbidden("You don't have access to this mailbox");
      },
    });
    const { serve, token } = setup({ actions: fake });
    const result = await callTool(serve, token, "get_thread", { threadId: "th_9" });
    expect(result).toEqual({ isError: true, data: { code: "FORBIDDEN", message: "You don't have access to this mailbox" } });
  });

  test("internal errors stay hidden", async () => {
    const fake = fakeActions({
      "/threads/update": () => {
        throw new AppError("connection string leaked", "INTERNAL_ERROR", 500);
      },
    });
    const { serve, token } = setup({ actions: fake });
    const env = process.env as Record<string, string | undefined>;
    const original = env.NODE_ENV;
    env.NODE_ENV = "production";
    try {
      const result = await callTool(serve, token, "move_threads", { threadIds: ["th_1"], folder: "trash" });
      expect(result.data.message).not.toContain("leaked");
    } finally {
      env.NODE_ENV = original;
    }
  });
});

describe("helpers", () => {
  test("reply recipients for the user's own message go back to its recipients", () => {
    const own = message({ direction: "outbound", fromAddress: "support@acme.test" });
    expect(replyRecipients(own as never, "support@acme.test", false)).toEqual({
      to: ["support@acme.test", "grace@example.com"],
      cc: [],
    });
    const withReplyTo = message({ replyTo: ["billing@example.com"] });
    expect(replyRecipients(withReplyTo as never, "support@acme.test", false).to).toEqual(["billing@example.com"]);
  });

  test("text and HTML convert both ways", () => {
    expect(textToHtml("a <b>\nc")).toBe("<p>a &lt;b&gt;<br>c</p>");
    expect(htmlToText("<style>p{}</style><p>Hi&nbsp;there</p><p>Bye<br>now</p>")).toBe("Hi there\nBye\nnow");
  });
});
