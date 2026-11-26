import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { attachments, supportConversations, threads } from "@hellobox/db";
import { resetExtensions } from "@hellobox/extensions";
import { eq } from "drizzle-orm";
import { hasServices, memoryStorage, recordedAfter, testDb, testSupportInbox, testWorkspace } from "../../../../../packages/mail/src/testing";

memoryStorage();
const { postSupportMessage, setSupportWebhookEnqueue } = await import("@hellobox/mail");
const { getAttachment, getConversation, listConversations, setConversationStatus } = await import("./read");

describe.skipIf(!hasServices)("reading conversations back", () => {
  const db = testDb();
  let w: Awaited<ReturnType<typeof testWorkspace>>;
  let inbox: Awaited<ReturnType<typeof testSupportInbox>>;
  let conversationId = "";
  let messageId = "";
  beforeAll(async () => {
    setSupportWebhookEnqueue(async () => undefined as never);
    w = await testWorkspace();
    inbox = await testSupportInbox(w);
    const result = await postSupportMessage(await inbox.row(), { user: { id: "u1", email: "ada@customer.test" }, text: "Help", idempotencyKey: "k" }, "api", recordedAfter());
    if (result.status !== "stored") throw new Error(result.status);
    ({ conversationId, messageId } = result);
  });
  afterAll(resetExtensions);

  const call = async (handler: (request: Request) => Promise<Response>, path: string, init: RequestInit & { key?: string } = {}) => {
    const response = await handler(new Request(`http://x/api/support/v1${path}`, {
      ...init,
      headers: { authorization: `Bearer ${init.key ?? inbox.key}`, "content-type": "application/json", ...init.headers },
    }));
    return { status: response.status, body: (await response.json()) as Record<string, unknown> & { error?: { code: string } } };
  };

  test("lists and reads a customer's own conversation", async () => {
    const list = await call(listConversations, "/conversations?userId=u1");
    expect(list).toMatchObject({ status: 200, body: { conversations: [{ id: conversationId, status: "open", subject: "Help" }], nextCursor: null } });
    const one = await call((r) => getConversation(r, conversationId), `/conversations/${conversationId}?userId=u1`);
    expect(one).toMatchObject({ status: 200, body: { id: conversationId, messages: [{ id: messageId, from: "customer", text: "Help" }] } });
  });

  test("needs a key and a userId, and answers anyone else exactly like a missing conversation", async () => {
    expect((await call(listConversations, "/conversations?userId=u1", { key: "hbs_nope" })).status).toBe(401);
    expect(await call(listConversations, "/conversations")).toMatchObject({ status: 400, body: { error: { code: "invalid_request" } } });
    expect((await call(listConversations, "/conversations?userId=u2")).body).toMatchObject({ conversations: [] });
    const missing = await call((r) => getConversation(r, "nope"), "/conversations/nope?userId=u1");
    const someoneElse = await call((r) => getConversation(r, conversationId), `/conversations/${conversationId}?userId=u2`);
    const otherKey = await call((r) => getConversation(r, conversationId), `/conversations/${conversationId}?userId=u1`, { key: (await testSupportInbox(w)).key });
    expect(missing).toMatchObject({ status: 404 });
    expect(someoneElse).toEqual(missing);
    expect(otherKey).toEqual(missing);
  });

  test("the customer can solve and reopen it", async () => {
    const set = (status: string, userId = "u1") =>
      call((r) => setConversationStatus(r, conversationId), `/conversations/${conversationId}/status`, { method: "POST", body: JSON.stringify({ userId, status }) });
    expect((await set("solved", "u2")).status).toBe(404);
    expect((await set("in_progress")).status).toBe(400);
    expect(await set("solved")).toMatchObject({ status: 200, body: { status: "solved" } });
    const [row] = await db.select({ folder: threads.folder }).from(supportConversations).innerJoin(threads, eq(threads.id, supportConversations.threadId)).where(eq(supportConversations.id, conversationId));
    expect(row!.folder).toBe("archive");
    expect(await set("open")).toMatchObject({ status: 200, body: { status: "open" } });
  });

  test("gives a short-lived link to the customer's own files only", async () => {
    const [file] = await db.insert(attachments).values({ workspaceId: w.workspace.id, messageId, filename: "a.png", contentType: "image/png", size: 1, storageKey: "key-1" }).returning();
    const link = await call((r) => getAttachment(r, file!.id), `/attachments/${file!.id}?userId=u1`);
    expect(link).toMatchObject({ status: 200, body: { url: "https://storage.test/key-1" } });
    expect(new Date(link.body.expiresAt as string).getTime()).toBeLessThanOrEqual(Date.now() + 15 * 60_000);
    expect((await call((r) => getAttachment(r, file!.id), `/attachments/${file!.id}?userId=u2`)).status).toBe(404);
  });
});
