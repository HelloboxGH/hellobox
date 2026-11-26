import { createHash } from "node:crypto";
import {
  getDb,
  rules,
  senderLists,
  supportConversations,
  supportMessages,
  type SupportMetadata,
} from "@hellobox/db";
import { entitlementsFor } from "@hellobox/extensions";
import { enqueueNotify } from "@hellobox/queue";
import { and, eq, gte, ne, or, sql } from "drizzle-orm";
import { applyRules } from "../categorize";
import { publishEvent } from "../realtime";
import { classifySpam, senderPolicy } from "../spam";
import { DuplicateMessage, storeInbound } from "../store-inbound";
import { makeSnippet } from "../threading";
import { claimFiles } from "./files";
import { supportMessageAdded } from "./read";
import { recordSupportEvent } from "./webhooks";
import type { SupportInbox } from "./keys";
import { subjectFrom } from "./text";

export interface SupportMessage {
  // `id` is the developer's own, and is what makes the customer verified.
  user: { id?: string; email: string; name?: string };
  text: string;
  subject?: string;
  conversationId?: string;
  idempotencyKey: string;
  metadata?: SupportMetadata;
}

/** A file that's in storage and not in the inbox yet: see files.ts. */
export interface SupportFile {
  uploadId: string;
  storageKey: string;
  filename: string;
  contentType: string;
  size: number;
  hash: string;
}

export interface SupportUpload {
  messageId: string;
  files: SupportFile[];
}

export type SupportSource = "api" | "hosted" | "form";

export type PostResult =
  | { status: "stored" | "repeated"; conversationId: string; messageId: string }
  // The same key came with something else.
  | { status: "key-reused" }
  // No such conversation, or it isn't this customer's.
  | { status: "not-found" }
  | { status: "limit"; max: number; resetAt: Date };

// The same content in the same shape, whatever order the keys came in.
export function contentHash(message: SupportMessage, files: Pick<SupportFile, "filename" | "hash">[] = []) {
  const { user, text, subject, conversationId, metadata } = message;
  const sorted = Object.entries(metadata ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
  return createHash("sha256")
    .update(JSON.stringify([
      user.id ?? null, user.email, user.name ?? null, text, subject ?? null, conversationId ?? null, metadata ? sorted : null,
      files.map((file) => [file.filename, file.hash]),
    ]))
    .digest("hex");
}

async function firstResult(inboxId: string, idempotencyKey: string, hash: string): Promise<PostResult | null> {
  const [row] = await getDb()
    .select({ conversationId: supportMessages.conversationId, messageId: supportMessages.messageId, contentHash: supportMessages.contentHash })
    .from(supportMessages)
    .where(and(eq(supportMessages.inboxId, inboxId), eq(supportMessages.idempotencyKey, idempotencyKey)));
  if (!row) return null;
  if (row.contentHash !== hash) return { status: "key-reused" };
  return { status: "repeated", conversationId: row.conversationId, messageId: row.messageId };
}

/** What an earlier request with this idempotency key got, if there was one. */
export const earlierResult = (inbox: SupportInbox, message: SupportMessage, files: Pick<SupportFile, "filename" | "hash">[] = []) =>
  firstResult(inbox.inbox.id, message.idempotencyKey, contentHash(message, files));

export async function idempotencyKeyUsed(inbox: SupportInbox, idempotencyKey: string) {
  const [row] = await getDb()
    .select({ id: supportMessages.id })
    .from(supportMessages)
    .where(and(eq(supportMessages.inboxId, inbox.inbox.id), eq(supportMessages.idempotencyKey, idempotencyKey)));
  return Boolean(row);
}

const monthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
const nextMonth = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

// Messages customers sent from apps this month. Answers by email never count: mail that
// arrives is never refused.
async function monthlyUse(workspaceId: string, now: Date) {
  const [row] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(supportMessages)
    .where(
      and(
        eq(supportMessages.workspaceId, workspaceId),
        ne(supportMessages.source, "email"),
        gte(supportMessages.createdAt, monthStart(now)),
      ),
    );
  return row?.count ?? 0;
}

interface After {
  notify(messageId: string): Promise<unknown>;
  publish(workspaceId: string, threadId: string): Promise<unknown>;
}

const defaultAfter: After = {
  notify: enqueueNotify,
  publish: (workspaceId, threadId) => publishEvent(workspaceId, { type: "thread.updated", threadId }),
};

/**
 * Stores a customer's message as a conversation, or in one of theirs. Without `user.id`
 * nobody vouched for the address, so it's always a new conversation.
 */
export async function postSupportMessage(
  row: SupportInbox,
  message: SupportMessage,
  source: SupportSource,
  after: After = defaultAfter,
  upload?: SupportUpload,
  // Why a public form thinks this is spam. It's kept, in Spam, with these reasons.
  suspected: string[] = [],
): Promise<PostResult> {
  const db = getDb();
  const { inbox, mailbox } = row;
  const { workspaceId } = inbox;
  const files = upload?.files ?? [];
  const hash = contentHash(message, files);
  const earlier = await firstResult(inbox.id, message.idempotencyKey, hash);
  if (earlier) return earlier;

  const verified = Boolean(message.user.id);
  if (message.conversationId && !message.user.id) return { status: "not-found" };
  const [existing] = message.conversationId && message.user.id
    ? await db
        .select()
        .from(supportConversations)
        .where(
          and(
            eq(supportConversations.id, message.conversationId),
            eq(supportConversations.inboxId, inbox.id),
            eq(supportConversations.externalUserId, message.user.id),
            eq(supportConversations.verified, true),
          ),
        )
    : [];
  if (message.conversationId && !existing) return { status: "not-found" };

  const now = new Date();
  const max = (await entitlementsFor(workspaceId)).limits.supportMessages;
  if (Number.isFinite(max) && (await monthlyUse(workspaceId, now)) >= max) {
    return { status: "limit", max, resetAt: nextMonth(now) };
  }

  const { email, name } = message.user;
  const subject = message.subject || subjectFrom(message.text);
  const [senderEntries, workspaceRules] = await Promise.all([
    db.select().from(senderLists).where(eq(senderLists.workspaceId, workspaceId)),
    db
      .select()
      .from(rules)
      .where(and(eq(rules.workspaceId, workspaceId), eq(rules.enabled, true)))
      .orderBy(rules.priority),
  ]);
  // No raw email to score: only the workspace's own lists decide, and a sender it allowed
  // is never spam.
  const policy = senderPolicy(email, senderEntries);
  const verdict = await classifySpam({ raw: null, policy, attachmentNames: [] });
  const suspicious = suspected.length > 0 && !policy.allowed;
  const spamReasons = suspicious ? [...verdict.reasons, ...suspected] : verdict.reasons;
  const action = applyRules(workspaceRules, { fromAddress: email, to: [mailbox.address], subject });
  const folder = verdict.isSpam || suspicious ? "spam" : (action.folder ?? "inbox");
  const messageId = upload?.messageId ?? crypto.randomUUID();
  const conversationId = existing?.id ?? crypto.randomUUID();
  const from = { address: email, ...(name ? { name } : {}) };
  const to = { address: mailbox.address };

  const threadId = await storeInbound({
    message: {
      id: messageId,
      workspaceId,
      direction: "inbound",
      // No Message-ID: the customer has no such email to answer.
      fromAddress: email,
      fromName: name,
      toRecipients: [to],
      subject,
      snippet: makeSnippet(message.text),
      textBody: message.text,
      spamReasons,
      sentAt: now,
    },
    mailboxId: mailbox.id,
    participants: [from, to],
    files: files.map(({ filename, contentType, size, storageKey }) => ({ workspaceId, messageId, filename, contentType, size, storageKey })),
    storedBytes: files.reduce((sum, file) => sum + file.size, 0),
    folder,
    category: action.category ?? "primary",
    labelId: action.labelId,
    findThread: async () => existing?.threadId ?? null,
    // The customer is waiting, so writing again also brings it back from Trash.
    folderFor: (current, next) => (next === "inbox" && (current === "archive" || current === "trash") ? "inbox" : current),
    within: async (tx, id) => {
      if (files.length) await claimFiles(tx, files);
      if (existing) {
        await tx
          .update(supportConversations)
          .set({
            ...(folder === "spam" ? {} : { status: "open" as const }),
            ...(message.metadata ? { metadata: message.metadata } : {}),
          })
          .where(eq(supportConversations.id, existing.id));
        if (folder !== "spam" && existing.status !== "open") {
          await recordSupportEvent(tx, existing, "conversation.status_changed", { status: "open" });
        }
      } else {
        await tx.insert(supportConversations).values({
          id: conversationId,
          workspaceId,
          inboxId: inbox.id,
          threadId: id,
          externalUserId: message.user.id,
          email,
          name,
          verified,
          metadata: message.metadata ?? {},
        });
      }
      // Replies go to a verified customer's newest address, in every conversation they have.
      if (message.user.id) {
        await tx
          .update(supportConversations)
          .set({ email, ...(name ? { name } : {}) })
          .where(
            and(
              eq(supportConversations.inboxId, inbox.id),
              eq(supportConversations.externalUserId, message.user.id),
              eq(supportConversations.verified, true),
              or(ne(supportConversations.email, email), name ? sql`${supportConversations.name} is distinct from ${name}` : undefined),
            ),
          );
      }
      const [recorded] = await tx
        .insert(supportMessages)
        .values({
          workspaceId,
          inboxId: inbox.id,
          conversationId,
          messageId,
          source,
          idempotencyKey: message.idempotencyKey,
          contentHash: hash,
        })
        .onConflictDoNothing({ target: [supportMessages.inboxId, supportMessages.idempotencyKey] })
        .returning({ id: supportMessages.id });
      // The same request, sent again while the first was still being stored.
      if (!recorded) throw new DuplicateMessage();
      await supportMessageAdded(tx, id, { id: messageId, direction: "inbound", fromAddress: email, toRecipients: [to], ccRecipients: [], sentAt: now });
    },
  });
  if (!threadId) {
    const first = await firstResult(inbox.id, message.idempotencyKey, hash);
    if (!first) throw new Error("Couldn't store the message");
    return first;
  }

  // It's stored, so a failure from here on mustn't look like one.
  await Promise.all([after.publish(workspaceId, threadId), after.notify(messageId)]).catch((error: unknown) =>
    console.error(`[support] Couldn't announce ${messageId}:`, error),
  );
  return { status: "stored", conversationId, messageId };
}
