import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { attachments, messages, rules, senderLists, supportConversations, supportInboxes, supportKeys, supportMessages, threads, threadUserState, workspaces } from "@hellobox/db";
import { resetExtensions, UNLIMITED } from "@hellobox/extensions";
import { and, eq } from "drizzle-orm";
import { hasServices, testDb, recordedAfter, testReply, testSupportInbox, testWorkspace, memoryStorage } from "../testing";
import { isAuthenticated } from "./email";
import { generateSupportKey, hashSupportKey, looksLikeSupportKey } from "./keys";
import { contentHash, type SupportMessage } from "./messages";
import { cleanLine, cleanText, subjectFrom } from "./text";

memoryStorage();
const { ingestEmail } = await import("../ingest");
const { postSupportMessage } = await import("./messages");
const { findSupportKey, supportInboxProblem } = await import("./keys");

const PASS = "Authentication-Results: mx; spf=pass; dkim=pass; dmarc=pass\r\n";

describe("support text", () => {
  test("keeps line breaks and drops what Postgres can't store", () => {
    expect(cleanText("a\r\nb\u0000\u0007\tc\ud800")).toBe("a\nb\tc�");
    expect(cleanText("😀")).toBe("😀");
    expect(cleanLine(" a\n b ")).toBe("a b");
  });

  test("a conversation with no subject takes its first line", () => {
    expect(subjectFrom("\n\n  Hello there \nmore")).toBe("Hello there");
    expect(subjectFrom("x".repeat(200))).toHaveLength(80);
  });
});

describe("support keys", () => {
  test("are random, recognisable and stored as a hash", () => {
    const { key, hash, prefix } = generateSupportKey();
    expect(looksLikeSupportKey(key)).toBe(true);
    expect(hash).toBe(hashSupportKey(key));
    expect(hash).not.toContain(key.slice(4));
    expect(key.startsWith(prefix)).toBe(true);
    expect(prefix.length).toBeLessThan(12);
    expect(generateSupportKey().key).not.toBe(key);
    expect(looksLikeSupportKey("hbs_short")).toBe(false);
  });
});

test("only mail that passed DMARC, or both SPF and DKIM, is authenticated", () => {
  expect(isAuthenticated({ dmarc: "pass" })).toBe(true);
  expect(isAuthenticated({ spf: "pass", dkim: "pass" })).toBe(true);
  expect(isAuthenticated({ spf: "pass", dkim: "pass", dmarc: "fail" })).toBe(false);
  expect(isAuthenticated({ spf: "pass" })).toBe(false);
  expect(isAuthenticated({ dkim: "pass" })).toBe(false);
  expect(isAuthenticated(null)).toBe(false);
});

test("the content hash ignores key order and notices every field", () => {
  const base: SupportMessage = { user: { id: "1", email: "a@x.test" }, text: "Hi", idempotencyKey: "k", metadata: { a: 1, b: 2 } };
  expect(contentHash({ ...base, metadata: { b: 2, a: 1 }, idempotencyKey: "other" })).toBe(contentHash(base));
  for (const change of [
    { text: "Hi!" }, { subject: "S" }, { conversationId: "c" }, { metadata: { a: 1 } }, { metadata: undefined },
    { user: { id: "2", email: "a@x.test" } }, { user: { id: "1", email: "b@x.test" } }, { user: { id: "1", email: "a@x.test", name: "A" } },
  ]) expect(contentHash({ ...base, ...change })).not.toBe(contentHash(base));
});

describe.skipIf(!hasServices)("support messages", () => {
  const db = testDb();
  let w: Awaited<ReturnType<typeof testWorkspace>>;
  let inbox: Awaited<ReturnType<typeof testSupportInbox>>;
  const after = recordedAfter();
  let counter = 0;
  const post = async (message: Partial<SupportMessage> & { user: SupportMessage["user"] }, to = inbox) =>
    postSupportMessage(await to.row(), { text: "Help", idempotencyKey: `k${++counter}`, ...message }, "api", after);
  const stored = async (message: Parameters<typeof post>[0], to = inbox) => {
    const result = await post(message, to);
    if (result.status !== "stored") throw new Error(result.status);
    return result;
  };
  const conversation = async (id: string) => (await db.select().from(supportConversations).where(eq(supportConversations.id, id)))[0]!;
  const thread = async (id: string) => (await db.select().from(threads).where(eq(threads.id, id)))[0]!;
  const ingest = async (mail: Parameters<typeof w.receive>[0]) => {
    const result = await ingestEmail(w.connection.id, await w.receive(mail));
    if (result.status !== "ingested") throw new Error(result.status);
    return result;
  };

  beforeAll(async () => {
    w = await testWorkspace();
    inbox = await testSupportInbox(w);
  });
  afterAll(resetExtensions);

  test("becomes a conversation in the mailbox, with no Message-ID", async () => {
    const result = await stored({ user: { id: "u1", email: "ada@customer.test", name: "Ada" }, text: "Where is it?\nThanks", metadata: { plan: "pro" } });
    const c = await conversation(result.conversationId);
    expect(c).toMatchObject({ workspaceId: w.workspace.id, inboxId: inbox.id, externalUserId: "u1", email: "ada@customer.test", name: "Ada", verified: true, status: "open", metadata: { plan: "pro" } });
    expect(await thread(c.threadId)).toMatchObject({ mailboxId: w.mailbox.id, folder: "inbox", subject: "Where is it?", messageCount: 1, snippet: "Where is it? Thanks" });
    const [message] = await db.select().from(messages).where(eq(messages.id, result.messageId));
    expect(message).toMatchObject({ direction: "inbound", connectionId: null, providerMessageId: null, messageIdHeader: null, fromAddress: "ada@customer.test", fromName: "Ada", textBody: "Where is it?\nThanks", htmlBody: null, unscanned: false });
    expect(after.notified).toContain(result.messageId);
  });

  test("the same key and content answers with the first result, even at once", async () => {
    const message: SupportMessage = { user: { id: "u2", email: "bo@customer.test" }, text: "Once", idempotencyKey: "same" };
    const results = await Promise.all([post(message), post(message), post(message)]);
    const ids = new Set(results.map((r) => "messageId" in r && r.messageId));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.status === "stored")).toHaveLength(1);
    expect(await post(message)).toMatchObject({ status: "repeated", messageId: [...ids][0] });
    expect(await post({ ...message, text: "Twice" })).toEqual({ status: "key-reused" });
    expect(await db.select().from(supportConversations).where(and(eq(supportConversations.inboxId, inbox.id), eq(supportConversations.externalUserId, "u2")))).toHaveLength(1);
    expect(await db.select().from(threads).where(and(eq(threads.workspaceId, w.workspace.id), eq(threads.subject, "Once")))).toHaveLength(1);
  });

  test("a customer continues their own conversation, and only their own", async () => {
    const first = await stored({ user: { id: "u3", email: "cy@customer.test" } });
    expect(await stored({ user: { id: "u3", email: "cy@customer.test" }, conversationId: first.conversationId, text: "More" })).toMatchObject({ conversationId: first.conversationId });
    expect((await thread((await conversation(first.conversationId)).threadId)).messageCount).toBe(2);
    // Someone else, and nobody vouched for, even with the same address.
    expect(await post({ user: { id: "u4", email: "cy@customer.test" }, conversationId: first.conversationId })).toEqual({ status: "not-found" });
    expect(await post({ user: { email: "cy@customer.test" }, conversationId: first.conversationId })).toEqual({ status: "not-found" });
    // Another inbox of the same workspace, and another workspace.
    expect(await post({ user: { id: "u3", email: "cy@customer.test" }, conversationId: first.conversationId }, await testSupportInbox(w))).toEqual({ status: "not-found" });
    const other = await testWorkspace();
    expect(await post({ user: { id: "u3", email: "cy@customer.test" }, conversationId: first.conversationId }, await testSupportInbox(other))).toEqual({ status: "not-found" });
    w.installAll();
    expect(await post({ user: { id: "u3", email: "cy@customer.test" }, conversationId: "missing" })).toEqual({ status: "not-found" });
  });

  test("an unverified message is always a new conversation", async () => {
    const verified = await stored({ user: { id: "u5", email: "di@customer.test" }, subject: "Same" });
    const a = await stored({ user: { email: "di@customer.test" }, subject: "Re: Same" });
    const b = await stored({ user: { email: "di@customer.test" }, subject: "Re: Same" });
    expect(new Set([verified.conversationId, a.conversationId, b.conversationId]).size).toBe(3);
    expect(await conversation(a.conversationId)).toMatchObject({ verified: false, externalUserId: null });
    expect((await conversation(verified.conversationId)).email).toBe("di@customer.test");
  });

  test("replies go to a verified customer's newest address, in every conversation", async () => {
    const first = await stored({ user: { id: "u6", email: "old@customer.test" } });
    await stored({ user: { id: "u6", email: "new@customer.test", name: "Eve" } });
    expect(await conversation(first.conversationId)).toMatchObject({ email: "new@customer.test", name: "Eve" });
    // An unverified message never changes it.
    await stored({ user: { email: "new@customer.test" } });
    expect((await conversation(first.conversationId)).email).toBe("new@customer.test");
  });

  test("a new message reopens a solved conversation, unread, in the inbox", async () => {
    const first = await stored({ user: { id: "u7", email: "flo@customer.test" } });
    const { threadId } = await conversation(first.conversationId);
    await db.update(supportConversations).set({ status: "solved" }).where(eq(supportConversations.id, first.conversationId));
    await db.update(threads).set({ folder: "archive" }).where(eq(threads.id, threadId));
    await db.insert(threadUserState).values({ threadId, userId: w.owner.id, readAt: new Date() });
    await stored({ user: { id: "u7", email: "flo@customer.test" }, conversationId: first.conversationId });
    expect((await conversation(first.conversationId)).status).toBe("open");
    expect((await thread(threadId)).folder).toBe("inbox");
    expect((await db.select().from(threadUserState).where(eq(threadUserState.threadId, threadId)))[0]!.readAt).toBeNull();
    await db.update(threads).set({ folder: "trash", trashedAt: new Date() }).where(eq(threads.id, threadId));
    await stored({ user: { id: "u7", email: "flo@customer.test" }, conversationId: first.conversationId });
    expect(await thread(threadId)).toMatchObject({ folder: "inbox", trashedAt: null });
  });

  test("blocked senders go to Spam with the reason, and rules apply", async () => {
    await db.insert(senderLists).values({ workspaceId: w.workspace.id, kind: "blocked", value: "bad.test" });
    await db.insert(rules).values({ workspaceId: w.workspace.id, name: "r", conditions: [{ field: "fromDomain", op: "equals", value: "ruled.test" }], action: { folder: "archive", category: "notifications" } });
    const blocked = await stored({ user: { id: "bad", email: "x@bad.test" } });
    expect((await thread((await conversation(blocked.conversationId)).threadId)).folder).toBe("spam");
    expect((await db.select().from(messages).where(eq(messages.id, blocked.messageId)))[0]!.spamReasons).toEqual(["Sender blocked"]);
    const ruled = await stored({ user: { id: "ruled", email: "x@ruled.test" } });
    expect(await thread((await conversation(ruled.conversationId)).threadId)).toMatchObject({ folder: "archive", category: "notifications" });
  });

  test("app, email, app, email stays one conversation here and in the headers", async () => {
    const user = { id: "u8", email: "gus@customer.test" };
    const first = await stored({ user, subject: "Order 7" });
    const { threadId } = await conversation(first.conversationId);
    const reply1 = await testReply(w, { threadId, replyToMessageId: first.messageId, to: [user.email] });
    expect(reply1.headers["In-Reply-To"]).toBeUndefined();
    const id1 = reply1.message.messageIdHeader!;

    const byEmail = await ingest({ from: "Gus <gus@customer.test>", subject: "Re: Order 7", messageId: "<gus1@c.test>", headers: `${PASS}In-Reply-To: ${id1}\r\nReferences: ${id1}\r\n` });
    expect(byEmail.threadId).toBe(threadId);
    const reply2 = await testReply(w, { threadId, replyToMessageId: byEmail.messageId, to: [user.email] });
    expect(reply2.headers).toMatchObject({ "In-Reply-To": "<gus1@c.test>", References: `${id1} <gus1@c.test>` });
    const id2 = reply2.message.messageIdHeader!;

    const again = await stored({ user, conversationId: first.conversationId, text: "Still broken" });
    // A colleague elsewhere is written to from the same conversation in between.
    await testReply(w, { threadId, replyToMessageId: null, to: ["boss@elsewhere.test"] });
    const reply3 = await testReply(w, { threadId, replyToMessageId: again.messageId, to: [user.email] });
    expect(reply3.headers).toMatchObject({ "In-Reply-To": id2, References: `${id1} <gus1@c.test> ${id2}` });
    expect(reply3.message).toMatchObject({ threadId, inReplyTo: id2, references: [id1, "<gus1@c.test>", id2] });

    const last = await ingest({ from: "gus@customer.test", subject: "Re: Order 7", headers: `${PASS}In-Reply-To: ${reply3.message.messageIdHeader}\r\n` });
    expect(last.threadId).toBe(threadId);
    expect((await db.select().from(supportConversations).where(eq(supportConversations.threadId, threadId)))).toHaveLength(1);
    const theirs = await db.select().from(supportMessages).where(eq(supportMessages.conversationId, first.conversationId));
    expect(theirs.map((m) => m.source).sort()).toEqual(["api", "api", "email", "email"]);
  });

  test("a reply to ordinary mail keeps its headers as they were", async () => {
    const mail = await ingest({ from: "hana@c.test", subject: "Plain", messageId: "<h2@c.test>", headers: "References: <h1@c.test>\r\n" });
    const reply = await testReply(w, { threadId: mail.threadId, replyToMessageId: mail.messageId, to: ["hana@c.test"] });
    expect(reply.headers).toMatchObject({ "In-Reply-To": "<h2@c.test>", References: "<h1@c.test> <h2@c.test>" });
    const fresh = await testReply(w, { threadId: null, replyToMessageId: null, to: ["hana@c.test"] });
    expect(fresh.headers["In-Reply-To"]).toBeUndefined();
    expect(fresh.headers.References).toBeUndefined();
  });

  test("an email joins by its ids alone, never by address or subject", async () => {
    const first = await stored({ user: { id: "u9", email: "ivy@customer.test" }, subject: "Refund" });
    const { threadId } = await conversation(first.conversationId);
    const forged = await ingest({ from: "ivy@customer.test", subject: "Re: Refund", headers: PASS });
    expect(forged.threadId).not.toBe(threadId);
    expect((await thread(threadId)).messageCount).toBe(1);
  });

  test("an email counts as the customer's only when it's really from them", async () => {
    const user = { id: "u10", email: "jo@customer.test" };
    const first = await stored({ user });
    const { threadId } = await conversation(first.conversationId);
    const { message } = await testReply(w, { threadId, replyToMessageId: first.messageId, to: [user.email] });
    const answer = async (from: string, auth: string) => {
      await db.update(supportConversations).set({ status: "solved" }).where(eq(supportConversations.id, first.conversationId));
      const result = await ingest({ from, subject: "Re: Help", headers: `${auth}In-Reply-To: ${message.messageIdHeader}\r\n` });
      // The team sees it either way, and it reopens.
      expect(result.threadId).toBe(threadId);
      const { spamReasons } = (await db.select().from(messages).where(eq(messages.id, result.messageId)))[0]!;
      // Failing DMARC can also score it as spam, which reopens nothing.
      if (!spamReasons?.length) expect((await conversation(first.conversationId)).status).toBe("open");
      const [row] = await db.select().from(supportMessages).where(eq(supportMessages.messageId, result.messageId));
      return Boolean(row);
    };
    expect(await answer("jo@customer.test", PASS)).toBe(true);
    expect(await answer("jo@customer.test", "Authentication-Results: mx; spf=pass; dkim=pass\r\n")).toBe(true);
    expect(await answer("jo@customer.test", "Authentication-Results: mx; spf=pass; dkim=pass; dmarc=fail\r\n")).toBe(false);
    expect(await answer("jo@customer.test", "Authentication-Results: mx; spf=pass\r\n")).toBe(false);
    expect(await answer("jo@customer.test", "")).toBe(false);
    expect(await answer("colleague@customer.test", PASS)).toBe(false);
  });

  test("a form customer's emailed answer joins their conversation", async () => {
    const first = await stored({ user: { email: "kai@customer.test" }, subject: "Form" });
    const c = await conversation(first.conversationId);
    expect(c.verified).toBe(false);
    const { message } = await testReply(w, { threadId: c.threadId, replyToMessageId: first.messageId, to: ["kai@customer.test"] });
    const answer = async (from: string) => {
      const result = await ingest({ from, subject: "Re: Form", headers: `${PASS}In-Reply-To: ${message.messageIdHeader}\r\n` });
      expect(result.threadId).toBe(c.threadId);
      return (await db.select().from(supportMessages).where(eq(supportMessages.messageId, result.messageId))).length === 1;
    };
    expect(await answer("kai@customer.test")).toBe(true);
    expect(await answer("someone@else.test")).toBe(false);
  });

  test("refused when nobody could answer", async () => {
    const problem = async () => supportInboxProblem(await inbox.row());
    expect(await problem()).toBeNull();
    const tries: [() => Promise<unknown>, () => Promise<unknown>][] = [];
    const { domains, mailboxes } = await import("@hellobox/db");
    const domain = (set: object) => db.update(domains).set(set).where(eq(domains.id, w.domain.id));
    const mailbox = (set: object) => db.update(mailboxes).set(set).where(eq(mailboxes.id, w.mailbox.id));
    const workspace = (set: object) => db.update(workspaces).set(set).where(eq(workspaces.id, w.workspace.id));
    tries.push(
      [() => domain({ sendingEnabled: false }), () => domain({ sendingEnabled: true })],
      [() => domain({ enabled: false }), () => domain({ enabled: true })],
      [() => domain({ removedAt: new Date() }), () => domain({ removedAt: null })],
      [() => mailbox({ removedAt: new Date() }), () => mailbox({ removedAt: null })],
      [() => mailbox({ personalUserId: w.owner.id }), () => mailbox({ personalUserId: null })],
      [() => workspace({ suspendedAt: new Date() }), () => workspace({ suspendedAt: null })],
    );
    for (const [breakIt, fix] of tries) {
      await breakIt();
      expect(await problem()).toBeString();
      await fix();
      expect(await problem()).toBeNull();
    }
  });

  test("a revoked or unknown key finds nothing", async () => {
    expect((await findSupportKey(inbox.key))?.inbox.id).toBe(inbox.id);
    expect(await findSupportKey(generateSupportKey().key)).toBeNull();
    const other = await testSupportInbox(w);
    await db.update(supportKeys).set({ revokedAt: new Date() }).where(eq(supportKeys.inboxId, other.id));
    expect(await findSupportKey(other.key)).toBeNull();
  });

  test("the monthly limit counts messages from apps, and never an email", async () => {
    const small = await testWorkspace();
    const own = await testSupportInbox(small);
    small.installAll({ billing: { entitlements: async () => ({ ...UNLIMITED, limits: { ...UNLIMITED.limits, supportMessages: 2 } }), denied: () => new Error("denied") } });
    const a = await stored({ user: { id: "a", email: "a@customer.test" } }, own);
    const { threadId } = await conversation(a.conversationId);
    const { message } = await testReply(small, { threadId, replyToMessageId: a.messageId, to: ["a@customer.test"] });
    const emailId = await small.receive({ from: "a@customer.test", subject: "Re: Help", headers: `${PASS}In-Reply-To: ${message.messageIdHeader}\r\n` });
    expect((await ingestEmail(small.connection.id, emailId)).status).toBe("ingested");
    const b = { user: { id: "a", email: "a@customer.test" }, text: "Second", idempotencyKey: "second" };
    await stored(b, own);
    const refused = await post({ user: { id: "a", email: "a@customer.test" } }, own);
    expect(refused).toMatchObject({ status: "limit", max: 2 });
    if (refused.status === "limit") expect(refused.resetAt.getTime()).toBeGreaterThan(Date.now());
    // A retry of one that was stored still gets its answer.
    expect((await post(b, own)).status).toBe("repeated");
    w.installAll();
  });

  test("a failure while storing leaves nothing, and the retry works", async () => {
    const message: SupportMessage = { user: { id: "u11", email: "kit@customer.test" }, text: "Fragile", idempotencyKey: "fragile" };
    const row = await inbox.row();
    const broken = { ...row, inbox: { ...row.inbox, id: "gone" } };
    await expect(postSupportMessage(broken, message, "api", after)).rejects.toThrow();
    expect(await db.select().from(threads).where(and(eq(threads.workspaceId, w.workspace.id), eq(threads.subject, "Fragile")))).toHaveLength(0);
    expect((await post(message)).status).toBe("stored");
  });

  test("stored still answers stored when announcing it fails", async () => {
    const fail = async () => { throw new Error("redis down"); };
    const result = await postSupportMessage(await inbox.row(), { user: { id: "u12", email: "lu@customer.test" }, text: "Hi", idempotencyKey: "announce" }, "api", { notify: fail, publish: fail });
    expect(result.status).toBe("stored");
  });

  test("deleting a conversation, or the workspace, takes everything with it", async () => {
    const gone = await testWorkspace();
    const own = await testSupportInbox(gone);
    const first = await stored({ user: { id: "x", email: "x@customer.test" } }, own);
    await stored({ user: { id: "y", email: "y@customer.test" } }, own);
    await db.insert(attachments).values({ workspaceId: gone.workspace.id, messageId: first.messageId, filename: "f", contentType: "x/y", storageKey: "k" });
    await db.delete(threads).where(eq(threads.id, (await conversation(first.conversationId)).threadId));
    expect(await db.select().from(supportMessages).where(eq(supportMessages.conversationId, first.conversationId))).toHaveLength(0);
    await db.delete(workspaces).where(eq(workspaces.id, gone.workspace.id));
    for (const table of [supportInboxes, supportKeys, supportConversations, supportMessages]) {
      expect(await db.select().from(table).where(eq(table.workspaceId, gone.workspace.id))).toHaveLength(0);
    }
    w.installAll();
  });
});
