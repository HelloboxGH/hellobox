import { attachments, getDb, mailboxes, messages, supportConversations, supportInboxes, supportMessages, threads } from "@hellobox/db";
import { and, asc, desc, eq, inArray, lt, or } from "drizzle-orm";
import type { StoreTx } from "../store-inbound";
import { withoutQuotes } from "./text";
import { recordSupportEvent } from "./webhooks";

// What a customer may see of their conversation: the messages they wrote, and the sent ones
// addressed to them, in To or Cc. Never notes, labels, assignees, Bcc, drafts, mail from
// anyone else, or a message sent to someone else. Text only, without quoted history.

type Db = ReturnType<typeof getDb> | StoreTx;
type Conversation = typeof supportConversations.$inferSelect;
type Message = Pick<typeof messages.$inferSelect, "id" | "direction" | "fromAddress" | "toRecipients" | "ccRecipients">;

const lower = (value: string) => value.trim().toLowerCase();

/** The customer's own messages, and every address they wrote from. */
async function customerSide(db: Db, conversation: Conversation) {
  const own = await db
    .select({ messageId: supportMessages.messageId, fromAddress: messages.fromAddress })
    .from(supportMessages)
    .innerJoin(messages, eq(messages.id, supportMessages.messageId))
    .where(eq(supportMessages.conversationId, conversation.id));
  return {
    ids: new Set(own.map((row) => row.messageId)),
    addresses: new Set([conversation.email, ...own.map((row) => row.fromAddress)].map(lower)),
  };
}

const visibleTo = (side: Awaited<ReturnType<typeof customerSide>>) => (message: Message) =>
  side.ids.has(message.id) ||
  (message.direction === "outbound" &&
    [...message.toRecipients, ...message.ccRecipients].some((person) => side.addresses.has(lower(person.address))));

/** A conversation that's this customer's in this inbox, or null: anything else looks missing. */
async function ownConversation(inboxId: string, userId: string, conversationId: string) {
  const [conversation] = await getDb()
    .select()
    .from(supportConversations)
    .where(
      and(
        eq(supportConversations.id, conversationId),
        eq(supportConversations.inboxId, inboxId),
        eq(supportConversations.externalUserId, userId),
        eq(supportConversations.verified, true),
      ),
    );
  return conversation ?? null;
}

const PAGE = 20;
const encodeCursor = (at: Date, id: string) => Buffer.from(JSON.stringify([at.toISOString(), id])).toString("base64url");
function decodeCursor(cursor: string | undefined) {
  if (!cursor) return null;
  try {
    const [at, id] = JSON.parse(Buffer.from(cursor, "base64url").toString()) as [string, string];
    const date = new Date(at);
    return typeof id === "string" && !Number.isNaN(date.getTime()) ? { at: date, id } : null;
  } catch {
    return null;
  }
}

const conversationSummary = (row: { conversation: Conversation; subject: string }) => ({
  id: row.conversation.id,
  subject: row.subject,
  status: row.conversation.status,
  createdAt: row.conversation.createdAt.toISOString(),
  lastMessageAt: row.conversation.lastMessageAt.toISOString(),
});

/** A customer's conversations, newest first. `invalid` for a cursor we didn't make. */
export async function listCustomerConversations(inboxId: string, userId: string, cursor?: string) {
  const after = decodeCursor(cursor);
  if (cursor && !after) return { status: "invalid" as const };
  const rows = await getDb()
    .select({ conversation: supportConversations, subject: threads.subject })
    .from(supportConversations)
    .innerJoin(threads, eq(threads.id, supportConversations.threadId))
    .where(
      and(
        eq(supportConversations.inboxId, inboxId),
        eq(supportConversations.externalUserId, userId),
        eq(supportConversations.verified, true),
        after
          ? or(
              lt(supportConversations.lastMessageAt, after.at),
              and(eq(supportConversations.lastMessageAt, after.at), lt(supportConversations.id, after.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(supportConversations.lastMessageAt), desc(supportConversations.id))
    .limit(PAGE + 1);
  const page = rows.slice(0, PAGE);
  const last = page.at(-1);
  return {
    status: "ok" as const,
    conversations: page.map(conversationSummary),
    nextCursor: rows.length > PAGE && last ? encodeCursor(last.conversation.lastMessageAt, last.conversation.id) : null,
  };
}

const MAX_MESSAGES = 200;

/** One conversation as its customer sees it, or null. */
export async function getCustomerConversation(inboxId: string, userId: string, conversationId: string) {
  const conversation = await ownConversation(inboxId, userId, conversationId);
  if (!conversation) return null;
  const db = getDb();
  const [[thread], side, all] = await Promise.all([
    db
      .select({ subject: threads.subject, inbox: supportInboxes.name, displayName: mailboxes.displayName })
      .from(threads)
      .innerJoin(supportInboxes, eq(supportInboxes.id, conversation.inboxId))
      .innerJoin(mailboxes, eq(mailboxes.id, supportInboxes.mailboxId))
      .where(eq(threads.id, conversation.threadId)),
    customerSide(db, conversation),
    db
      .select({
        id: messages.id,
        direction: messages.direction,
        fromAddress: messages.fromAddress,
        toRecipients: messages.toRecipients,
        ccRecipients: messages.ccRecipients,
        textBody: messages.textBody,
        htmlBody: messages.htmlBody,
        createdAt: messages.createdAt,
        source: supportMessages.source,
      })
      .from(messages)
      .leftJoin(supportMessages, eq(supportMessages.messageId, messages.id))
      .where(eq(messages.threadId, conversation.threadId))
      // In the order they arrived here: an email's own date can say anything.
      .orderBy(asc(messages.createdAt), asc(messages.sentAt)),
  ]);
  if (!thread) return null;
  const shown = all.filter(visibleTo(side)).slice(-MAX_MESSAGES);
  const files = shown.length
    ? await db
        .select({ id: attachments.id, messageId: attachments.messageId, filename: attachments.filename, contentType: attachments.contentType, size: attachments.size })
        .from(attachments)
        .where(inArray(attachments.messageId, shown.map((message) => message.id)))
    : [];
  // Replies carry the mailbox's name, never the teammate's.
  const team = thread.displayName || thread.inbox;
  return {
    ...conversationSummary({ conversation, subject: thread.subject }),
    messages: shown.map((message) => {
      const fromCustomer = side.ids.has(message.id);
      return {
        id: message.id,
        from: fromCustomer ? ("customer" as const) : ("team" as const),
        name: fromCustomer ? conversation.name : team,
        // What an app sent is exactly what the customer typed.
        text: message.source === "api" || message.source === "hosted" || message.source === "form" ? (message.textBody ?? "") : withoutQuotes(message),
        createdAt: message.createdAt.toISOString(),
        attachments: files
          .filter((file) => file.messageId === message.id)
          .map(({ messageId: _messageId, ...file }) => file),
      };
    }),
  };
}

/** A file the customer may download, or null. */
export async function customerAttachment(inboxId: string, userId: string, attachmentId: string) {
  const db = getDb();
  const [row] = await db
    .select({ file: attachments, message: messages, conversationId: supportConversations.id })
    .from(attachments)
    .innerJoin(messages, eq(messages.id, attachments.messageId))
    .innerJoin(supportConversations, eq(supportConversations.threadId, messages.threadId))
    .where(eq(attachments.id, attachmentId));
  if (!row) return null;
  const conversation = await ownConversation(inboxId, userId, row.conversationId);
  if (!conversation) return null;
  return visibleTo(await customerSide(db, conversation))(row.message) ? row.file : null;
}

/**
 * A message joined a conversation. If the customer can see it, their list moves it up and
 * the webhook hears of it. Runs in the transaction that stored the message.
 */
export async function supportMessageAdded(tx: StoreTx, threadId: string, message: Message & { sentAt: Date }) {
  const [conversation] = await tx.select().from(supportConversations).where(eq(supportConversations.threadId, threadId));
  if (!conversation) return;
  const side = await customerSide(tx, conversation);
  if (!visibleTo(side)(message)) return;
  await tx
    .update(supportConversations)
    .set({ lastMessageAt: message.sentAt })
    .where(and(eq(supportConversations.id, conversation.id), lt(supportConversations.lastMessageAt, message.sentAt)));
  await recordSupportEvent(tx, conversation, "message.created", {
    messageId: message.id,
    from: side.ids.has(message.id) ? "customer" : "team",
  });
}
