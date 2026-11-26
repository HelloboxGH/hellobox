import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { attachments, labels, messages, rules, senderLists, threadLabels, threads, threadUserState, webhookEvents, workspaces } from "@hellobox/db";
import { resetExtensions } from "@hellobox/extensions";
import { and, eq } from "drizzle-orm";
import { hasServices, testDb, storedFiles, testWorkspace, memoryStorage } from "./testing";

memoryStorage();
const { ingestEmail } = await import("./ingest");

describe.skipIf(!hasServices)("ingestEmail", () => {
  let w: Awaited<ReturnType<typeof testWorkspace>>;
  const db = testDb();
  const customer = "Ada Byron <ada@customer.test>";
  beforeAll(async () => { w = await testWorkspace(); });
  afterAll(resetExtensions);

  const ingest = async (mail: Parameters<typeof w.receive>[0]) => {
    const emailId = await w.receive(mail);
    const result = await ingestEmail(w.connection.id, emailId);
    if (result.status !== "ingested") throw new Error(result.status);
    const [message] = await db.select().from(messages).where(eq(messages.id, result.messageId));
    const [thread] = await db.select().from(threads).where(eq(threads.id, result.threadId));
    return { emailId, message: message!, thread: thread! };
  };
  const storage = async () => (await db.select().from(workspaces).where(eq(workspaces.id, w.workspace.id)))[0]!.storageBytesUsed;

  test("stores a new conversation, its files and their size", async () => {
    const before = await storage();
    const { message, thread, emailId } = await ingest({ from: customer, subject: "Broken lamp", text: "It broke.", messageId: "<one@c.test>", attachment: { filename: "photo.txt", content: "abc" } });
    expect(thread).toMatchObject({ workspaceId: w.workspace.id, mailboxId: w.mailbox.id, subject: "Broken lamp", normalizedSubject: "broken lamp", snippet: "It broke.", folder: "inbox", category: "primary", hasAttachments: true, messageCount: 1, expiresAt: null });
    expect(thread.participants).toEqual([{ address: "ada@customer.test", name: "Ada Byron" }, { address: w.address }]);
    expect(thread.lastMessageAt).toEqual(message.sentAt);
    expect(message).toMatchObject({
      connectionId: w.connection.id, direction: "inbound", providerMessageId: emailId, messageIdHeader: "<one@c.test>", inReplyTo: null, references: [],
      fromAddress: "ada@customer.test", fromName: "Ada Byron", toRecipients: [{ address: w.address }], subject: "Broken lamp", snippet: "It broke.", htmlBody: null, sealedBody: null, storageCounted: true,
    });
    expect(message.textBody?.trim()).toBe("It broke.");
    const files = await db.select().from(attachments).where(eq(attachments.messageId, message.id));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ workspaceId: w.workspace.id, filename: "photo.txt", providerAttachmentId: "part-1" });
    expect(storedFiles.has(files[0]!.storageKey)).toBe(true);
    expect(message.rawKey && storedFiles.get(message.rawKey)?.length).toBe(message.rawSize);
    expect(await storage()).toBe(before + message.rawSize + files[0]!.size);
  });

  test("joins by id, marks unread, unsnoozes and returns an archived conversation", async () => {
    const first = await ingest({ from: customer, subject: "Second lamp", messageId: "<two@c.test>" });
    await db.update(threads).set({ folder: "archive" }).where(eq(threads.id, first.thread.id));
    await db.insert(threadUserState).values({ threadId: first.thread.id, userId: w.owner.id, readAt: new Date(), starred: true, snoozedUntil: new Date(Date.now() + 60_000) });
    const reply = await ingest({ from: "Bob <bob@customer.test>", subject: "Something else", text: "More", headers: "In-Reply-To: <two@c.test>\r\nReferences: <zero@c.test> <two@c.test>\r\n" });
    expect(reply.thread).toMatchObject({ id: first.thread.id, folder: "inbox", messageCount: 2, snippet: "More", subject: "Second lamp" });
    expect(reply.thread.participants.map((p) => p.address)).toEqual(["ada@customer.test", w.address, "bob@customer.test"]);
    expect(reply.message).toMatchObject({ inReplyTo: "<two@c.test>", references: ["<zero@c.test>", "<two@c.test>"] });
    const [state] = await db.select().from(threadUserState).where(eq(threadUserState.threadId, first.thread.id));
    expect(state).toMatchObject({ readAt: null, snoozedUntil: null, starred: true });
  });

  test("falls back to the subject and a shared participant", async () => {
    const first = await ingest({ from: customer, subject: "Third lamp" });
    const reply = await ingest({ from: customer, subject: "Re: Third lamp" });
    expect(reply.thread.id).toBe(first.thread.id);
    const stranger = await ingest({ from: "x@other.test", subject: "Third lamp" });
    expect(stranger.thread.id).not.toBe(first.thread.id);
  });

  test("leaves a conversation in Trash there", async () => {
    const first = await ingest({ from: customer, subject: "Fourth lamp", messageId: "<four@c.test>" });
    await db.update(threads).set({ folder: "trash", trashedAt: new Date() }).where(eq(threads.id, first.thread.id));
    const reply = await ingest({ from: customer, subject: "Re: Fourth lamp", headers: "In-Reply-To: <four@c.test>\r\n" });
    expect(reply.thread).toMatchObject({ id: first.thread.id, folder: "trash" });
  });

  test("applies rules, labels and blocked senders", async () => {
    const [label] = await db.insert(labels).values({ workspaceId: w.workspace.id, name: "VIP" }).returning();
    await db.insert(rules).values({ workspaceId: w.workspace.id, name: "VIP", conditions: [{ field: "fromDomain", op: "equals", value: "vip.test" }], action: { labelId: label!.id, folder: "archive", category: "purchases" } });
    const ruled = await ingest({ from: "boss@vip.test", subject: "Hi" });
    expect(ruled.thread).toMatchObject({ folder: "archive", category: "purchases" });
    expect(await db.select().from(threadLabels).where(eq(threadLabels.threadId, ruled.thread.id))).toEqual([{ threadId: ruled.thread.id, labelId: label!.id }]);
    await db.insert(senderLists).values({ workspaceId: w.workspace.id, kind: "blocked", value: "bad.test" });
    const blocked = await ingest({ from: "x@bad.test", subject: "Buy" });
    expect(blocked.thread.folder).toBe("spam");
    expect(blocked.message.spamReasons).toEqual(["Sender blocked"]);
  });

  test("the same email twice, even at once, is stored once and its event is done", async () => {
    const emailId = await w.receive({ from: customer, subject: "Fifth lamp" });
    await db.insert(webhookEvents).values({ connectionId: w.connection.id, providerEventId: emailId, type: "email.received", emailId, payload: {} });
    const before = await storage();
    const results = await Promise.all([ingestEmail(w.connection.id, emailId), ingestEmail(w.connection.id, emailId)]);
    expect(results.map((r) => r.status).sort()).toEqual(["duplicate", "ingested"]);
    expect((await ingestEmail(w.connection.id, emailId)).status).toBe("duplicate");
    const rows = await db.select().from(messages).where(eq(messages.providerMessageId, emailId));
    expect(rows).toHaveLength(1);
    expect(await storage()).toBe(before + rows[0]!.rawSize);
    const [event] = await db.select().from(webhookEvents).where(eq(webhookEvents.emailId, emailId));
    expect(event!.processedAt).not.toBeNull();
    expect(await db.select().from(threads).where(and(eq(threads.workspaceId, w.workspace.id), eq(threads.subject, "Fifth lamp")))).toHaveLength(1);
  });

  test("a flood is quarantined on its own, uncounted", async () => {
    const first = await ingest({ from: "spammer@flood.test", subject: "Flood", messageId: "<flood@f.test>" });
    for (let i = 0; i < 29; i += 1) await ingest({ from: "spammer@flood.test", subject: `Flood ${i}` });
    const before = await storage();
    const quarantined = await ingest({ from: "spammer@flood.test", subject: "Re: Flood", headers: "In-Reply-To: <flood@f.test>\r\n" });
    expect(quarantined.thread.id).not.toBe(first.thread.id);
    expect(quarantined.thread.folder).toBe("spam");
    expect(quarantined.thread.expiresAt).not.toBeNull();
    expect(quarantined.message.storageCounted).toBe(false);
    expect(await storage()).toBe(before);
  });
});
