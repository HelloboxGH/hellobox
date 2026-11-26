import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { domains, messages, supportConversations, supportKeys, supportMessages, workspaces } from "@hellobox/db";
import { install, resetExtensions, UNLIMITED } from "@hellobox/extensions";
import { eq } from "drizzle-orm";
import { hasServices, testDb, recordedAfter, testSupportInbox, testWorkspace, memoryStorage } from "../../../../../packages/mail/src/testing";

memoryStorage();
const { postSupportMessage } = await import("@hellobox/mail");
const { postMessage } = await import("./messages");
const { readBody } = await import("./http");
const { parseMessage } = await import("./schema");

const after = recordedAfter();
const valid = { user: { id: "u1", email: "ada@customer.test" }, text: "Help", idempotencyKey: "k1" };

describe("the proxy", () => {
  test("leaves the support API alone, and nothing else that it handled before", async () => {
    // Read as text: importing the proxy brings in the whole app.
    const source = await Bun.file(new URL("../../../proxy.ts", import.meta.url)).text();
    const matcher = new RegExp(`^${source.match(/matcher: \["(.+)"\]/)![1]}$`);
    expect(matcher.test("/api/support/v1/messages")).toBe(false);
    for (const path of ["/", "/inbox", "/api/actions/v1/threads/list", "/support", "/api/supported", "/api/attachments/x"]) {
      expect(matcher.test(path)).toBe(true);
    }
  });
});

describe("message fields", () => {
  const refused = (change: object, message?: string) => {
    expect(() => parseMessage(JSON.stringify({ ...valid, ...change }))).toThrow(message);
  };
  test("are cleaned", () => {
    const parsed = parseMessage(JSON.stringify({ ...valid, user: { id: " u1 ", email: " Ada@Customer.TEST ", name: "A\r\nBcc: x" }, text: "a\u0000b", subject: "x\ny" }));
    expect(parsed).toMatchObject({ user: { id: "u1", email: "ada@customer.test", name: "A Bcc: x" }, text: "ab", subject: "x y" });
    expect(parseMessage(JSON.stringify({ ...valid, user: { ...valid.user, name: "" }, subject: " " }))).toMatchObject({ user: { name: undefined }, subject: undefined });
  });
  test("are refused when wrong", () => {
    refused({ user: undefined }, "user");
    refused({ user: { email: "nope" } }, "user.email");
    refused({ user: { email: "a@x.test", id: "a\u0000" } }, "user.id");
    refused({ text: "" }, "text");
    refused({ text: " \n\u0000 " }, "text");
    refused({ text: "x".repeat(50_001) }, "text");
    refused({ idempotencyKey: undefined }, "idempotencyKey");
    refused({ idempotencyKey: "" }, "idempotencyKey");
    refused({ conversationId: "c", user: { email: "a@x.test" } }, "user.id");
    refused({ metadata: { nested: { a: 1 } } }, "metadata");
    refused({ metadata: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i])) }, "20 keys");
    refused({ metadata: { big: "x".repeat(4096) } }, "4 KB");
    expect(() => parseMessage("{")).toThrow("JSON");
    expect(() => parseMessage("[]")).toThrow();
  });
});

test("a body is counted as it arrives, whatever Content-Length says", async () => {
  let pulled = 0;
  const endless = () => new ReadableStream<Uint8Array>({ pull(c) { pulled += 1; c.enqueue(new Uint8Array(1024)); } });
  const request = (headers: Record<string, string>, body: BodyInit = endless()) =>
    new Request("http://x/", { method: "POST", headers, body, duplex: "half" } as RequestInit);
  await expect(readBody(request({ "content-length": "10" }), 4096)).rejects.toMatchObject({ status: 413 });
  expect(pulled).toBeLessThan(20);
  await expect(readBody(request({ "content-length": "5000" }), 4096)).rejects.toMatchObject({ status: 413 });
  await expect(readBody(request({ "content-length": "1e3" }), 4096)).rejects.toMatchObject({ status: 400 });
  await expect(readBody(request({}, new ReadableStream({})), 4096, 30)).rejects.toMatchObject({ status: 408 });
  expect(await readBody(request({}, "hé"), 4096)).toBe("hé");
});

describe.skipIf(!hasServices)("POST /api/support/v1/messages", () => {
  const db = testDb();
  let w: Awaited<ReturnType<typeof testWorkspace>>;
  let inbox: Awaited<ReturnType<typeof testSupportInbox>>;
  let counter = 0;
  beforeAll(async () => {
    w = await testWorkspace();
    inbox = await testSupportInbox(w);
  });
  afterAll(resetExtensions);

  const send = async (body: unknown, options: { key?: string | null; headers?: Record<string, string> } = {}) => {
    const { key = inbox.key, headers } = options;
    const response = await postMessage(
      new Request("http://x/api/support/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      (row, message, source) => postSupportMessage(row, message, source, after),
    );
    return { status: response.status, headers: response.headers, body: (await response.json()) as { conversationId?: string; messageId?: string; error?: { code: string; message: string } } };
  };
  const fresh = (change: object = {}) => ({ ...valid, idempotencyKey: `f${++counter}`, user: { id: `user-${counter}`, email: "ada@customer.test" }, ...change });

  test("stores the message and answers with its ids", async () => {
    const result = await send(valid);
    expect(result.status).toBe(201);
    expect(Object.keys(result.body).sort()).toEqual(["conversationId", "messageId"]);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(await db.select().from(messages).where(eq(messages.id, result.body.messageId!))).toHaveLength(1);
    const again = await send(valid);
    expect(again).toMatchObject({ status: 201, body: result.body });
    const changed = await send({ ...valid, text: "Other" });
    expect(changed).toMatchObject({ status: 409, body: { error: { code: "idempotency_key_reused" } } });
    expect(await db.select().from(supportMessages).where(eq(supportMessages.inboxId, inbox.id))).toHaveLength(1);
    const [key] = await db.select().from(supportKeys).where(eq(supportKeys.inboxId, inbox.id));
    expect(key!.lastUsedAt).not.toBeNull();
  });

  test("refuses a missing, malformed or revoked key", async () => {
    for (const key of [null, "hbs_nope", `hbs_${"a".repeat(43)}`, `${inbox.key} extra`]) {
      expect(await send(fresh(), { key })).toMatchObject({ status: 401, body: { error: { code: "invalid_key" } } });
    }
    const other = await testSupportInbox(w);
    expect((await send(fresh(), { key: other.key })).status).toBe(201);
    await db.update(supportKeys).set({ revokedAt: new Date() }).where(eq(supportKeys.inboxId, other.id));
    expect((await send(fresh(), { key: other.key })).status).toBe(401);
  });

  test("refuses what it can't read", async () => {
    expect(await send("{", {})).toMatchObject({ status: 400, body: { error: { code: "invalid_request" } } });
    expect(await send(fresh(), { headers: { "content-type": "text/plain" } })).toMatchObject({ status: 415 });
    expect(await send(fresh({ text: "x".repeat(600_000) }))).toMatchObject({ status: 413 });
  });

  test("another customer's, inbox's or workspace's conversation looks like a missing one", async () => {
    const mine = await send(fresh({ user: { id: "owner", email: "o@customer.test" } }));
    const conversationId = mine.body.conversationId!;
    const missing = await send(fresh({ conversationId: crypto.randomUUID() }));
    expect(missing.status).toBe(404);
    const elsewhere = await testWorkspace();
    const otherInbox = await testSupportInbox(elsewhere);
    w.installAll();
    const asOwner = { user: { id: "owner", email: "o@customer.test" }, conversationId };
    for (const attempt of [
      await send(fresh({ user: { id: "intruder", email: "o@customer.test" }, conversationId })),
      await send(fresh(asOwner), { key: (await testSupportInbox(w)).key }),
      await send(fresh(asOwner), { key: otherInbox.key }),
    ]) {
      expect(attempt.status).toBe(404);
      expect(attempt.body).toEqual(missing.body);
    }
    expect((await send(fresh(asOwner))).body.conversationId).toBe(conversationId);
    expect(await send(fresh({ user: { email: "o@customer.test" }, conversationId }))).toMatchObject({ status: 400 });
    expect(await db.select().from(supportConversations).where(eq(supportConversations.id, conversationId))).toHaveLength(1);
  });

  test("answers 409 when the workspace is suspended or the domain can't send", async () => {
    await db.update(workspaces).set({ suspendedAt: new Date() }).where(eq(workspaces.id, w.workspace.id));
    expect(await send(fresh())).toMatchObject({ status: 409, body: { error: { code: "unavailable" } } });
    await db.update(workspaces).set({ suspendedAt: null }).where(eq(workspaces.id, w.workspace.id));
    await db.update(domains).set({ sendingEnabled: false }).where(eq(domains.id, w.domain.id));
    expect(await send(fresh())).toMatchObject({ status: 409 });
    await db.update(domains).set({ sendingEnabled: true }).where(eq(domains.id, w.domain.id));
    expect((await send(fresh())).status).toBe(201);
  });

  test("limits one customer to 10 messages a minute, and a retry of a stored one still answers", async () => {
    const limited = await testSupportInbox(w);
    const user = { id: "busy", email: "b@customer.test" };
    for (let i = 0; i < 10; i += 1) expect((await send(fresh({ user, idempotencyKey: `busy-${i}` }), { key: limited.key })).status).toBe(201);
    const over = await send(fresh({ user }), { key: limited.key });
    expect(over).toMatchObject({ status: 429, body: { error: { code: "rate_limited" } } });
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await send(fresh({ user, idempotencyKey: "busy-0" }), { key: limited.key })).status).toBe(201);
    expect((await send(fresh({ user: { id: "calm", email: "c@customer.test" } }), { key: limited.key })).status).toBe(201);
  });

  test("limits a key to 60 requests a minute", async () => {
    const limited = await testSupportInbox(w);
    const results = await Promise.all(Array.from({ length: 61 }, () => send("{", { key: limited.key })));
    expect(results.filter((r) => r.status === 400)).toHaveLength(60);
    const over = results.find((r) => r.status === 429)!;
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  test("answers 429 over the plan's monthly messages", async () => {
    const small = await testWorkspace();
    const own = await testSupportInbox(small);
    install({ billing: { entitlements: async () => ({ ...UNLIMITED, limits: { ...UNLIMITED.limits, supportMessages: 1 } }), denied: () => new Error("denied") } });
    expect((await send(fresh(), { key: own.key })).status).toBe(201);
    const over = await send(fresh(), { key: own.key });
    expect(over).toMatchObject({ status: 429, body: { error: { code: "monthly_limit" } } });
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
    w.installAll();
  });

  test("an unexpected failure answers 500, stores nothing and says nothing about itself", async () => {
    const error = console.error;
    console.error = () => undefined;
    const response = await postMessage(
      new Request("http://x/", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${inbox.key}` }, body: JSON.stringify(fresh({ text: "secret failure" })) }),
      async () => { throw new Error("connection string leaked"); },
    );
    console.error = error;
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("leaked");
  });
});
