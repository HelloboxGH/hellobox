import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { messages, supportConversations, supportInboxes, supportKeys, supportMessages, supportSessions } from "@hellobox/db";
import { getExtensions, resetExtensions } from "@hellobox/extensions";
import { eq } from "drizzle-orm";
import { hasServices, memoryStorage, recordedAfter, testDb, testSupportInbox, testWorkspace } from "../../../../../packages/mail/src/testing";

memoryStorage();
// The open build's own: no hosted module is loaded, so what testWorkspace installs stays.
void mock.module("server-only", () => ({}));
void mock.module("@/core/extensions", () => ({ getExtensions }));
const { postSupportMessage, setSupportWebhookEnqueue } = await import("@hellobox/mail");
const { hosted } = await import("./hosted");
const { postSession } = await import("./sessions");
const { GET: page } = await import("../../../app/support/s/[inboxId]/route");
const { policy } = await import("./page");
const { siteOrigin } = await import("../actions/support");

test("allowed sites are origins, https or local", () => {
  expect(siteOrigin("app.example.com/path?x")).toBe("https://app.example.com");
  expect(siteOrigin("https://app.example.com:8443/")).toBe("https://app.example.com:8443");
  expect(siteOrigin("http://localhost:3000")).toBe("http://localhost:3000");
  for (const bad of ["http://app.example.com", "javascript:alert(1)", "https://u:p@app.example.com", "*", "'self'", "https://intranet", "ftp://x.com"]) {
    expect(siteOrigin(bad)).toBeNull();
  }
});

test("the page allows nothing it doesn't need, and only listed sites may frame it", () => {
  expect(policy([])).toContain("frame-ancestors 'none'");
  expect(policy(["https://a.test", "https://b.test"])).toContain("frame-ancestors https://a.test https://b.test");
  for (const part of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'self'", "base-uri 'none'", "form-action 'none'"]) {
    expect(policy([])).toContain(part);
  }
  expect(policy([])).not.toContain("unsafe");
});

describe.skipIf(!hasServices)("the hosted page", () => {
  const db = testDb();
  let w: Awaited<ReturnType<typeof testWorkspace>>;
  let inbox: Awaited<ReturnType<typeof testSupportInbox>>;
  const after = recordedAfter();
  beforeAll(async () => {
    setSupportWebhookEnqueue(async () => undefined as never);
    w = await testWorkspace();
    inbox = await testSupportInbox(w);
  });
  afterAll(resetExtensions);

  const link = async (user: object = { id: "u1", email: "ada@customer.test", name: "Ada" }, key = inbox.key) => {
    const response = await postSession(new Request("http://x/api/support/v1/sessions", {
      method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ user }),
    }));
    return { status: response.status, body: (await response.json()) as { url: string; expiresAt: string } };
  };
  const call = async (path: string, init: RequestInit & { session?: string } = {}) => {
    const response = await hosted(
      new Request(`http://x/api/support/hosted/${path}`, {
        ...init,
        headers: { ...(init.session ? { authorization: `Bearer ${init.session}` } : {}), "content-type": "application/json", ...init.headers },
      }),
      path.split("?")[0]!.split("/"),
      (row, message, source, _after, upload) => postSupportMessage(row, message, source, after, upload),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> & { error?: { code: string } } };
  };
  const exchange = (url: string, inboxId = inbox.id) =>
    call("session", { method: "POST", body: JSON.stringify({ inboxId, token: url.split("#")[1] }) });

  test("a link needs a signed-in customer, and works once", async () => {
    expect((await link({ email: "ada@customer.test" })).status).toBe(400);
    expect((await link(undefined, "hbs_nope")).status).toBe(401);
    const made = await link();
    expect(made.status).toBe(201);
    expect(made.body.url).toMatch(new RegExp(`/support/s/${inbox.id}#hst_`));
    expect(new Date(made.body.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
    expect((await exchange(made.body.url, (await testSupportInbox(w)).id)).status).toBe(401);
    const first = await exchange(made.body.url);
    expect(first).toMatchObject({ status: 200, body: { inbox: "App", user: { email: "ada@customer.test", name: "Ada" } } });
    expect(String(first.body.session)).toStartWith("hss_");
    expect((await exchange(made.body.url)).status).toBe(401);
    // Only hashes are kept.
    const [row] = await db.select().from(supportSessions).where(eq(supportSessions.inboxId, inbox.id));
    expect(JSON.stringify(row)).not.toContain(made.body.url.split("#")[1]);
    expect(JSON.stringify(row)).not.toContain(String(first.body.session));
  });

  test("an old link doesn't work", async () => {
    const made = await link();
    await db.update(supportSessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(supportSessions.inboxId, inbox.id));
    expect((await exchange(made.body.url)).status).toBe(401);
  });

  test("the customer is always the session's, whatever the request says", async () => {
    const session = String((await exchange((await link()).body.url)).body.session);
    const sent = await call("messages", {
      method: "POST", session,
      body: JSON.stringify({ text: "Hi from the page", idempotencyKey: "h1", user: { id: "someone-else", email: "evil@x.test" }, metadata: { plan: "enterprise" } }),
    });
    expect(sent.status).toBe(201);
    const [conversation] = await db.select().from(supportConversations).where(eq(supportConversations.id, String(sent.body.conversationId)));
    expect(conversation).toMatchObject({ externalUserId: "u1", email: "ada@customer.test", verified: true, metadata: {} });
    const [stored] = await db.select({ source: supportMessages.source, from: messages.fromAddress }).from(supportMessages).innerJoin(messages, eq(messages.id, supportMessages.messageId)).where(eq(supportMessages.messageId, String(sent.body.messageId)));
    expect(stored).toEqual({ source: "hosted", from: "ada@customer.test" });
    // Retrying the same draft stores it once.
    const again = await call("messages", { method: "POST", session, body: JSON.stringify({ text: "Hi from the page", idempotencyKey: "h1" }) });
    expect(again.body).toEqual({ conversationId: sent.body.conversationId, messageId: sent.body.messageId });

    const list = await call("conversations", { session });
    expect(list.body.conversations).toEqual([expect.objectContaining({ id: sent.body.conversationId })]);
    expect((await call(`conversations/${sent.body.conversationId}`, { session })).body).toMatchObject({ messages: [{ text: "Hi from the page", from: "customer" }] });
    expect((await call(`conversations/${sent.body.conversationId}/status`, { method: "POST", session, body: JSON.stringify({ status: "solved" }) })).status).toBe(200);

    // Someone else's conversation, in the same inbox, looks missing.
    const theirs = await postSupportMessage(await inbox.row(), { user: { id: "u2", email: "bo@customer.test" }, text: "Mine", idempotencyKey: "x" }, "api", after);
    if (theirs.status !== "stored") throw new Error(theirs.status);
    const missing = await call("conversations/nope", { session });
    expect(missing.status).toBe(404);
    expect(await call(`conversations/${theirs.conversationId}`, { session })).toEqual(missing);
    expect((await call(`conversations/${theirs.conversationId}/status`, { method: "POST", session, body: JSON.stringify({ status: "solved" }) })).status).toBe(404);
    expect((await call(`conversations/${theirs.conversationId}`, { session, method: "POST", body: "{}" })).status).toBe(404);
  });

  test("a session ends with its hour, a revoked key, or a deleted inbox", async () => {
    const session = String((await exchange((await link()).body.url)).body.session);
    expect((await call("conversations", { session })).status).toBe(200);
    expect((await call("conversations", { session: "hss_nope" })).status).toBe(401);
    expect((await call("conversations")).status).toBe(401);
    await db.update(supportSessions).set({ sessionExpiresAt: new Date(Date.now() - 1000) }).where(eq(supportSessions.inboxId, inbox.id));
    expect((await call("conversations", { session })).status).toBe(401);

    const other = await testSupportInbox(w);
    const second = String((await exchange((await link(undefined, other.key)).body.url, other.id)).body.session);
    expect((await call("conversations", { session: second })).status).toBe(200);
    await db.update(supportKeys).set({ revokedAt: new Date() }).where(eq(supportKeys.inboxId, other.id));
    expect((await call("conversations", { session: second })).status).toBe(401);
  });

  test("the page sends its policy, framed only by the inbox's sites", async () => {
    const headers = async (id: string) => (await page(new Request("http://x/"), { params: Promise.resolve({ inboxId: id }) })).headers;
    const none = await headers(inbox.id);
    expect(none.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(none.get("x-frame-options")).toBe("DENY");
    expect(none.get("referrer-policy")).toBe("no-referrer");
    await db.update(supportInboxes).set({ allowedOrigins: ["https://app.example.com"] }).where(eq(supportInboxes.id, inbox.id));
    const allowed = await headers(inbox.id);
    expect(allowed.get("content-security-policy")).toContain("frame-ancestors https://app.example.com");
    expect(allowed.get("x-frame-options")).toBeNull();
    expect((await headers("not-an-inbox")).get("content-security-policy")).toContain("frame-ancestors 'none'");
  });
});
