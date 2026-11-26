import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { attachments, supportConversations, supportInboxes, supportWebhookEvents, threadNotes } from "@hellobox/db";
import { resetExtensions } from "@hellobox/extensions";
import { eq } from "drizzle-orm";
import { signWebhook } from "../notifications/channels";
import { hasServices, memoryStorage, recordedAfter, testDb, testReply, testSupportInbox, testWorkspace } from "../testing";
import type { SupportMessage } from "./messages";
import { withoutQuotes } from "./text";

memoryStorage();
const { ingestEmail } = await import("../ingest");
const { postSupportMessage } = await import("./messages");
const { customerAttachment, getCustomerConversation, listCustomerConversations } = await import("./read");
const { setSupportStatus } = await import("./status");
const { deliverSupportWebhooks, generateWebhookSecret, sealWebhookSecret, setSupportWebhookEnqueue } = await import("./webhooks");

const PASS = "Authentication-Results: mx; spf=pass; dkim=pass; dmarc=pass\r\n";

describe("the new part of a message", () => {
  test("leaves out quoted history, in text and HTML", () => {
    const text = (textBody: string) => withoutQuotes({ textBody, htmlBody: null });
    expect(text("Thanks!\n\nOn Tue, 3 Nov 2026 at 10:00, Acme <support@acme.test> wrote:\n> secret")).toBe("Thanks!");
    expect(text("Yes\nOn Tue, 3 Nov 2026 at 10:00, Acme Support <support@acme.test>\nwrote:\n> x")).toBe("Yes");
    expect(text("Ok\n-----Original Message-----\nFrom: boss@acme.test")).toBe("Ok");
    expect(text("Ok\n________________________________\nFrom: Boss <boss@acme.test>\nSent: today")).toBe("Ok");
    expect(text("Fine\n> quoted")).toBe("Fine");
    expect(withoutQuotes({ textBody: "ignored", htmlBody: "<p>Hi &amp; bye</p><p><br></p><blockquote>On x, boss@acme.test wrote:<br>internal</blockquote>" })).toBe("Hi & bye");
    expect(withoutQuotes({ textBody: null, htmlBody: '<div>New</div><div class="gmail_quote">old</div>' })).toBe("New");
    expect(withoutQuotes({ textBody: null, htmlBody: "<style>p{}</style><p>a<br>b</p>" })).toBe("a\nb");
  });
});

describe.skipIf(!hasServices)("what a customer sees", () => {
  const db = testDb();
  let w: Awaited<ReturnType<typeof testWorkspace>>;
  let inbox: Awaited<ReturnType<typeof testSupportInbox>>;
  let other: Awaited<ReturnType<typeof testSupportInbox>>;
  const after = recordedAfter();
  const queued: string[] = [];
  let counter = 0;
  const stored = async (message: Partial<SupportMessage> & { user: SupportMessage["user"] }, to = inbox) => {
    const result = await postSupportMessage(await to.row(), { text: "Help", idempotencyKey: `r${++counter}`, ...message }, "api", after);
    if (result.status !== "stored") throw new Error(result.status);
    return result;
  };
  const ingest = async (mail: Parameters<typeof w.receive>[0]) => {
    const result = await ingestEmail(w.connection.id, await w.receive(mail));
    if (result.status !== "ingested") throw new Error(result.status);
    return result;
  };
  const events = () => db.select().from(supportWebhookEvents).where(eq(supportWebhookEvents.inboxId, inbox.id)).orderBy(supportWebhookEvents.createdAt);

  beforeAll(async () => {
    setSupportWebhookEnqueue(async (inboxId) => { queued.push(inboxId); return undefined as never; });
    w = await testWorkspace();
    inbox = await testSupportInbox(w);
    other = await testSupportInbox(w);
    await db.update(supportInboxes)
      .set({ webhookUrl: "https://app.example.test/hooks", webhookSecretEnc: sealWebhookSecret("whsec_test") })
      .where(eq(supportInboxes.id, inbox.id));
  });
  afterAll(resetExtensions);

  test("only their own messages and the replies addressed to them: never forwards, Bcc, notes or others' mail", async () => {
    const user = { id: "u1", email: "ada@customer.test", name: "Ada" };
    const first = await stored({ user, subject: "Refund", text: "Where is my refund?\n> not a quote, I typed it" });
    const conversation = (await getCustomerConversation(inbox.id, "u1", first.conversationId))!;
    const [{ threadId: thread } = { threadId: "" }] = await db.select({ threadId: supportConversations.threadId }).from(supportConversations).where(eq(supportConversations.id, first.conversationId));

    const reply = await testReply(w, {
      threadId: thread, replyToMessageId: first.messageId, to: [user.email],
      html: "<p>It's on its way.</p><p><br></p><blockquote>On x, ada@customer.test wrote:<br>Where is my refund?</blockquote>",
    });
    const forward = await testReply(w, {
      threadId: thread, replyToMessageId: null, to: ["boss@elsewhere.test"], cc: ["finance@elsewhere.test"],
      html: "<p>Internal: this customer is difficult. Approve?</p>",
    });
    const hidden = await testReply(w, { threadId: thread, replyToMessageId: null, to: ["boss@elsewhere.test"], bcc: [user.email], html: "<p>Bcc'd</p>" });
    await db.insert(threadNotes).values({ threadId: thread, userId: w.owner.id, body: "Note: VIP, refund silently" });
    await db.insert(attachments).values([
      { workspaceId: w.workspace.id, messageId: forward.message.id, filename: "internal.pdf", contentType: "application/pdf", size: 3, storageKey: "k1" },
      { workspaceId: w.workspace.id, messageId: reply.message.id, filename: "receipt.pdf", contentType: "application/pdf", size: 3, storageKey: "k2" },
    ]);
    // Someone else writes into the thread, once pretending to be the customer.
    await ingest({ from: "boss@elsewhere.test", subject: "Re: Refund", headers: `In-Reply-To: ${forward.message.messageIdHeader}\r\n`, text: "Approved, internal" });
    await ingest({ from: "ada@customer.test", subject: "Re: Refund", headers: `In-Reply-To: ${reply.message.messageIdHeader}\r\n`, text: "Forged" });
    // And the customer answers by email, quoting the reply.
    const answer = await ingest({
      from: "Ada <ada@customer.test>", subject: "Re: Refund", headers: `${PASS}In-Reply-To: ${reply.message.messageIdHeader}\r\n`,
      text: "Thanks!\n\nOn Tue, Acme support <support@acme.test> wrote:\n> It's on its way.",
    });

    const seen = (await getCustomerConversation(inbox.id, "u1", first.conversationId))!;
    expect(conversation.messages).toHaveLength(1);
    expect(seen.messages.map(({ from, name, text }) => ({ from, name, text }))).toEqual([
      { from: "customer", name: "Ada", text: "Where is my refund?\n> not a quote, I typed it" },
      { from: "team", name: "Acme support", text: "It's on its way." },
      { from: "customer", name: "Ada", text: "Thanks!" },
    ]);
    expect(seen.messages[1]!.attachments.map((file) => file.filename)).toEqual(["receipt.pdf"]);
    const everything = JSON.stringify(seen);
    for (const secret of ["Internal", "difficult", "Bcc'd", "VIP", "Approved", "Forged", "internal.pdf", "boss@", "finance@", w.owner.id, forward.message.id, hidden.message.id]) {
      expect(everything).not.toContain(secret);
    }
    const [internal] = await db.select().from(attachments).where(eq(attachments.messageId, forward.message.id));
    const [receipt] = await db.select().from(attachments).where(eq(attachments.messageId, reply.message.id));
    expect(await customerAttachment(inbox.id, "u1", internal!.id)).toBeNull();
    expect((await customerAttachment(inbox.id, "u1", receipt!.id))?.filename).toBe("receipt.pdf");
    expect(answer.messageId).toBe(seen.messages[2]!.id);

    // The webhook heard about exactly what the customer sees, by id only.
    const sent = (await events()).filter((event) => event.payload.conversationId === first.conversationId);
    expect(sent.map((event) => [event.type, event.payload])).toEqual([
      ["message.created", { conversationId: first.conversationId, userId: "u1", messageId: first.messageId, from: "customer" }],
      ["message.created", { conversationId: first.conversationId, userId: "u1", messageId: reply.message.id, from: "team" }],
      ["message.created", { conversationId: first.conversationId, userId: "u1", messageId: answer.messageId, from: "customer" }],
    ]);
    expect(queued).toContain(inbox.id);
  });

  test("anyone else's conversation looks missing", async () => {
    const mine = await stored({ user: { id: "u2", email: "bo@customer.test" } });
    const elsewhere = await stored({ user: { id: "u2", email: "bo@customer.test" } }, other);
    const unverified = await stored({ user: { email: "bo@customer.test" } });
    expect(await getCustomerConversation(inbox.id, "u3", mine.conversationId)).toBeNull();
    expect(await getCustomerConversation(other.id, "u2", mine.conversationId)).toBeNull();
    expect(await getCustomerConversation(inbox.id, "u2", elsewhere.conversationId)).toBeNull();
    expect(await getCustomerConversation(inbox.id, "u2", unverified.conversationId)).toBeNull();
    expect(await getCustomerConversation(inbox.id, "u2", "nope")).toBeNull();
    const list = await listCustomerConversations(inbox.id, "u2");
    expect(list).toMatchObject({ status: "ok", nextCursor: null });
    expect(list.status === "ok" && list.conversations.map((c) => c.id)).toEqual([mine.conversationId]);
    // Nobody vouched for the unverified one, so it's never announced either.
    expect((await events()).some((event) => event.payload.conversationId === unverified.conversationId)).toBe(false);
    expect(await listCustomerConversations(inbox.id, "u2", "garbage")).toEqual({ status: "invalid" });
  });

  test("lists newest first, a page at a time", async () => {
    const ids: string[] = [];
    for (let index = 0; index < 22; index += 1) ids.push((await stored({ user: { id: "u4", email: "cy@customer.test" }, text: `n${index}` })).conversationId);
    // An answer moves the oldest to the top.
    await stored({ user: { id: "u4", email: "cy@customer.test" }, conversationId: ids[0]!, text: "again" });
    const first = await listCustomerConversations(inbox.id, "u4");
    if (first.status !== "ok") throw new Error("invalid");
    expect(first.conversations[0]!.id).toBe(ids[0]);
    const second = await listCustomerConversations(inbox.id, "u4", first.nextCursor!);
    if (second.status !== "ok") throw new Error("invalid");
    expect([...first.conversations, ...second.conversations].map((c) => c.id).sort()).toEqual([...ids].sort());
    expect(second.nextCursor).toBeNull();
  });

  test("status changes are announced, and solving archives", async () => {
    const { conversationId } = await stored({ user: { id: "u5", email: "di@customer.test" } });
    await setSupportStatus([conversationId], "solved");
    await stored({ user: { id: "u5", email: "di@customer.test" }, conversationId });
    const changes = (await events())
      .filter((event) => event.payload.conversationId === conversationId && event.type === "conversation.status_changed")
      .map((event) => event.payload.status);
    expect(changes).toEqual(["solved", "open"]);
    expect((await getCustomerConversation(inbox.id, "u5", conversationId))!.status).toBe("open");
  });

  test("deliveries are signed, and a failing endpoint is paused instead of hammered", async () => {
    const secret = generateWebhookSecret();
    const fresh = await testSupportInbox(w);
    await db.update(supportInboxes).set({ webhookUrl: "https://app.example.test/h", webhookSecretEnc: sealWebhookSecret(secret) }).where(eq(supportInboxes.id, fresh.id));
    await stored({ user: { id: "u6", email: "ed@customer.test" } }, fresh);
    await stored({ user: { id: "u6", email: "ed@customer.test" } }, fresh);
    const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
    let status = 500;
    const post = async (url: string, body: string, headers: Record<string, string>) => {
      calls.push({ url, body, headers });
      return { status, body: "" };
    };
    expect(await deliverSupportWebhooks(fresh.id, post)).toMatchObject({ delivered: 0, error: "HTTP 500" });
    expect(calls).toHaveLength(1);
    const [paused] = await db.select().from(supportInboxes).where(eq(supportInboxes.id, fresh.id));
    expect(paused).toMatchObject({ webhookFailures: 1, webhookError: "HTTP 500" });
    // Paused: nothing is tried.
    await deliverSupportWebhooks(fresh.id, post);
    expect(calls).toHaveLength(1);
    await db.update(supportInboxes).set({ webhookPausedUntil: null }).where(eq(supportInboxes.id, fresh.id));
    status = 302;
    await deliverSupportWebhooks(fresh.id, post);
    expect(calls).toHaveLength(2);
    await db.update(supportInboxes).set({ webhookPausedUntil: null }).where(eq(supportInboxes.id, fresh.id));
    await db.update(supportWebhookEvents).set({ nextAttemptAt: new Date() }).where(eq(supportWebhookEvents.inboxId, fresh.id));
    status = 204;
    expect(await deliverSupportWebhooks(fresh.id, post)).toEqual({ delivered: 2 });
    const { headers, body } = calls.at(-1)!;
    expect(headers["X-HelloBox-Signature"]).toBe(signWebhook(secret, headers["X-HelloBox-Timestamp"]!, body));
    const event = JSON.parse(body) as { id: string; type: string; data: Record<string, string> };
    expect(event).toMatchObject({ id: headers["X-HelloBox-Event-Id"], type: "message.created", data: { userId: "u6", from: "customer" } });
    expect(body).not.toContain("http");
    expect((await db.select().from(supportInboxes).where(eq(supportInboxes.id, fresh.id)))[0]).toMatchObject({ webhookFailures: 0, webhookError: null });
    expect(await deliverSupportWebhooks(fresh.id, post)).toEqual({ delivered: 0 });
  });
});
