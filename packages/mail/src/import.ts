import { entitlementsFor } from "@hellobox/extensions";
import {
  attachments,
  getDb,
  imports,
  labels,
  mailboxes,
  mailboxMembers,
  messages,
  threadLabels,
  threads,
  threadUserState,
  workspaces,
} from "@hellobox/db";
import { parseRawEmail } from "@hellobox/providers";
import { deleteObject, messageKey, putObject, readObject } from "@hellobox/storage";
import { and, eq, inArray, sql } from "drizzle-orm";
import { bodyColumns, sealingKeysFor, type SealingKey } from "./encryption";
import { findThreadFor, mergeParticipants } from "./ingest";
import { MAX_EMAIL_BYTES, type MboxEntry, placementFor, readMbox } from "./mbox";
import { publishEvent } from "./realtime";
import { sanitizeEmailHtml } from "./sanitize";
import {
  makeSnippet,
  normalizeSubject,
  parseAddress,
  parseAddressList,
  parseMessageIds,
} from "./threading";

// Imports run quietly: no spam scoring, rules, notifications, bounces or webhooks. It's
// old mail the person already has, not new mail arriving.

const CHECKPOINT_EVERY = 25;

class StorageFull extends Error {}

type Context = {
  importId: string;
  workspaceId: string;
  userId: string;
  mailbox: typeof mailboxes.$inferSelect;
  readers: string[];
  sealingKeys: SealingKey[] | null;
  storageLimit: number;
  storageUsed: number;
  // Gmail's thread id to ours, so a conversation comes back whole.
  gmailThreads: Map<string, string>;
  labelIds: Map<string, string>;
};

const header = (headers: Record<string, string | string[]>, name: string) => {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
};

async function* single(stream: ReadableStream<Uint8Array>): AsyncGenerator<MboxEntry> {
  const raw = new Uint8Array(await new Response(stream).arrayBuffer());
  yield raw.length > MAX_EMAIL_BYTES
    ? { kind: "oversized", offset: raw.length }
    : { kind: "email", raw, offset: raw.length };
}

async function labelId(ctx: Context, name: string) {
  const known = ctx.labelIds.get(name.toLowerCase());
  if (known) return known;
  const db = getDb();
  await db.insert(labels).values({ workspaceId: ctx.workspaceId, name }).onConflictDoNothing();
  const [row] = await db
    .select({ id: labels.id })
    .from(labels)
    .where(and(eq(labels.workspaceId, ctx.workspaceId), eq(labels.name, name)));
  if (row) ctx.labelIds.set(name.toLowerCase(), row.id);
  return row?.id ?? null;
}

async function importOne(ctx: Context, raw: Uint8Array): Promise<"imported" | "skipped"> {
  const db = getDb();
  const messageId = crypto.randomUUID();
  const email = await parseRawEmail(messageId, raw);
  const from = parseAddress(email.from);
  const placement = placementFor(
    header(email.headers, "x-gmail-labels"),
    from.address.toLowerCase() === ctx.mailbox.address,
  );
  if (placement.skip || !from.address) return "skipped";
  const gmailThread = header(email.headers, "x-gm-thrid");

  // Already here: an earlier import of the same file, or the same email in two files.
  if (email.messageId) {
    const [existing] = await db
      .select({ threadId: messages.threadId })
      .from(messages)
      .innerJoin(threads, eq(threads.id, messages.threadId))
      .where(
        and(
          eq(messages.workspaceId, ctx.workspaceId),
          eq(threads.mailboxId, ctx.mailbox.id),
          eq(messages.messageIdHeader, email.messageId),
        ),
      )
      .limit(1);
    if (existing) {
      if (gmailThread) ctx.gmailThreads.set(gmailThread, existing.threadId);
      return "skipped";
    }
  }

  const files = await Promise.all(
    email.attachments.map(async (attachment) => ({
      attachment,
      bytes: new Uint8Array(await new Response(await attachment.open()).arrayBuffer()),
    })),
  );
  const bytes = files.reduce((sum, file) => sum + file.bytes.length, 0);
  if (ctx.storageUsed + bytes > ctx.storageLimit) throw new StorageFull();

  const to = parseAddressList(email.to);
  const cc = parseAddressList(email.cc);
  const subject = email.subject;
  const sentAt = email.sentAt;
  const references = parseMessageIds(header(email.headers, "references"));
  const inReplyTo = parseMessageIds(header(email.headers, "in-reply-to"))[0] ?? null;
  const participants = [from, ...to, ...cc];
  const html = email.html ? sanitizeEmailHtml(email.html) : null;
  const body = await bodyColumns({ text: email.text, html }, ctx.sealingKeys);
  const snippet = ctx.sealingKeys ? "" : makeSnippet(email.text, email.html);

  const stored: (typeof attachments.$inferInsert)[] = [];
  for (const { attachment, bytes: content } of files) {
    const storageKey = messageKey(ctx.workspaceId, `import-${messageId}`, attachment.id);
    await putObject(storageKey, content, attachment.contentType);
    stored.push({
      workspaceId: ctx.workspaceId,
      messageId,
      filename: attachment.filename,
      contentType: attachment.contentType,
      size: content.length,
      contentId: attachment.contentId,
      disposition: attachment.disposition,
      storageKey,
    });
  }

  const found =
    (gmailThread ? ctx.gmailThreads.get(gmailThread) : undefined) ??
    (await findThreadFor({
      mailboxId: ctx.mailbox.id,
      workspaceId: ctx.workspaceId,
      inReplyTo,
      references,
      subject,
      participants: participants.map((p) => p.address),
      sentAt,
    }));
  const labelIdList = (await Promise.all(placement.labels.map((name) => labelId(ctx, name)))).filter(
    (id): id is string => Boolean(id),
  );

  const threadId = await db.transaction(async (tx) => {
    let id = found;
    if (id) {
      const [thread] = await tx.select().from(threads).where(eq(threads.id, id));
      const newer = !thread || sentAt >= thread.lastMessageAt;
      await tx
        .update(threads)
        .set({
          ...(newer ? { snippet } : {}),
          participants: mergeParticipants(thread?.participants ?? [], participants),
          lastMessageAt: sql`greatest(${threads.lastMessageAt}, ${sentAt.toISOString()}::timestamptz)`,
          messageCount: sql`${threads.messageCount} + 1`,
          hasAttachments: sql`${threads.hasAttachments} or ${stored.length > 0}`,
          important: sql`${threads.important} or ${placement.important}`,
          // Any email of the conversation in the inbox brings the conversation there.
          ...(placement.folder === "inbox" && thread?.folder === "archive" ? { folder: "inbox" as const } : {}),
        })
        .where(eq(threads.id, id));
    } else {
      const [created] = await tx
        .insert(threads)
        .values({
          workspaceId: ctx.workspaceId,
          mailboxId: ctx.mailbox.id,
          subject,
          normalizedSubject: normalizeSubject(subject),
          snippet,
          participants: mergeParticipants([], participants),
          folder: placement.folder,
          category: placement.category,
          important: placement.important,
          hasAttachments: stored.length > 0,
          messageCount: 1,
          lastMessageAt: sentAt,
          trashedAt: placement.folder === "trash" ? new Date() : null,
        })
        .returning({ id: threads.id });
      id = created?.id ?? null;
    }
    if (!id) throw new Error("Could not create a thread");

    await tx.insert(messages).values({
      id: messageId,
      workspaceId: ctx.workspaceId,
      threadId: id,
      direction: placement.sent ? "outbound" : "inbound",
      messageIdHeader: email.messageId,
      inReplyTo,
      references,
      fromAddress: from.address,
      fromName: from.name,
      toRecipients: to,
      ccRecipients: cc,
      replyTo: email.replyTo,
      subject,
      snippet,
      ...body,
      authentication: email.authentication ?? null,
      sentByUserId: placement.sent ? ctx.userId : null,
      sentAt,
    });
    if (stored.length) await tx.insert(attachments).values(stored);
    if (labelIdList.length) {
      await tx
        .insert(threadLabels)
        .values(labelIdList.map((labelId) => ({ threadId: id, labelId })))
        .onConflictDoNothing();
    }
    // Read mail stays read for everyone who reads the mailbox, so an import doesn't bury
    // the team under unread counts. Unread and starred come from the person importing.
    await tx
      .insert(threadUserState)
      .values(
        ctx.readers.map((userId) => ({
          threadId: id,
          userId,
          readAt: placement.unread && userId === ctx.userId ? null : new Date(),
          starred: placement.starred && userId === ctx.userId,
        })),
      )
      .onConflictDoUpdate({
        target: [threadUserState.threadId, threadUserState.userId],
        set: {
          starred: sql`${threadUserState.starred} or excluded.starred`,
          // Unread if any of its emails is, as in Gmail.
          readAt: sql`case when excluded.read_at is null or ${threadUserState.readAt} is null then null else ${threadUserState.readAt} end`,
        },
      });
    if (bytes) {
      await tx
        .update(workspaces)
        .set({ storageBytesUsed: sql`${workspaces.storageBytesUsed} + ${bytes}` })
        .where(eq(workspaces.id, ctx.workspaceId));
    }
    return id;
  });
  ctx.storageUsed += bytes;
  if (gmailThread) ctx.gmailThreads.set(gmailThread, threadId);
  return "imported";
}

async function readersOf(mailbox: typeof mailboxes.$inferSelect, userId: string) {
  if (mailbox.personalUserId) return [mailbox.personalUserId];
  const rows = await getDb()
    .select({ userId: mailboxMembers.userId })
    .from(mailboxMembers)
    .where(eq(mailboxMembers.mailboxId, mailbox.id));
  return [...new Set([userId, ...rows.map((row) => row.userId)])];
}

// Safe to run again after a crash: it carries on from the last checkpoint, and emails
// already imported are recognized by their Message-ID.
export async function runImport(importId: string) {
  const db = getDb();
  const [job] = await db.select().from(imports).where(eq(imports.id, importId));
  if (!job || !["queued", "running"].includes(job.status)) return;
  const [mailbox] = await db.select().from(mailboxes).where(eq(mailboxes.id, job.mailboxId));
  if (!mailbox) {
    await db.update(imports).set({ status: "failed", error: "The mailbox was deleted", finishedAt: new Date() }).where(eq(imports.id, job.id));
    return;
  }
  await db.update(imports).set({ status: "running", startedAt: job.startedAt ?? new Date() }).where(eq(imports.id, job.id));

  const [[workspace], entitlements, labelRows] = await Promise.all([
    db.select({ used: workspaces.storageBytesUsed }).from(workspaces).where(eq(workspaces.id, job.workspaceId)),
    entitlementsFor(job.workspaceId),
    db.select({ id: labels.id, name: labels.name }).from(labels).where(eq(labels.workspaceId, job.workspaceId)),
  ]);
  const ctx: Context = {
    importId: job.id,
    workspaceId: job.workspaceId,
    userId: job.userId,
    mailbox,
    readers: await readersOf(mailbox, job.userId),
    sealingKeys: await sealingKeysFor(mailbox),
    storageLimit: entitlements.limits.storageBytes,
    storageUsed: workspace?.used ?? 0,
    gmailThreads: new Map(),
    labelIds: new Map(labelRows.map((row) => [row.name.toLowerCase(), row.id])),
  };

  const counts = { imported: job.imported, skipped: job.skipped, failed: job.failed };
  let bytesRead = job.bytesRead;
  const checkpoint = async () => {
    const [row] = await db
      .update(imports)
      .set({ ...counts, bytesRead })
      .where(eq(imports.id, job.id))
      .returning({ status: imports.status });
    await publishEvent(job.workspaceId, { type: "thread.updated" });
    return row?.status;
  };

  let error: string | null = null;
  try {
    const stream = await readObject(job.storageKey);
    const entries = job.format === "eml" ? single(stream) : readMbox(stream);
    let since = 0;
    for await (const entry of entries) {
      // Done before a restart.
      if (entry.offset <= job.bytesRead) continue;
      if (entry.kind === "oversized") counts.failed++;
      else {
        try {
          counts[await importOne(ctx, entry.raw)]++;
        } catch (failure) {
          if (failure instanceof StorageFull) throw failure;
          counts.failed++;
          console.warn(`[import] ${job.id}: an email couldn't be imported:`, failure);
        }
      }
      bytesRead = entry.offset;
      if (++since >= CHECKPOINT_EVERY) {
        since = 0;
        if ((await checkpoint()) === "cancelled") return;
      }
    }
    bytesRead = job.size;
  } catch (failure) {
    if (failure instanceof StorageFull) error = "Your plan's storage is full. Free some space or upgrade, then import the rest.";
    else throw failure;
  }

  await checkpoint();
  const [finished] = await db
    .update(imports)
    .set({ status: error ? "failed" : "done", error, finishedAt: new Date() })
    .where(and(eq(imports.id, job.id), inArray(imports.status, ["queued", "running"])))
    .returning({ id: imports.id });
  if (finished) await deleteObject(job.storageKey).catch(() => undefined);
}

// Called when the worker gives up on an import, so it doesn't look stuck.
export async function failImport(importId: string, message: string) {
  const db = getDb();
  const [row] = await db
    .update(imports)
    .set({ status: "failed", error: message, finishedAt: new Date() })
    .where(and(eq(imports.id, importId), inArray(imports.status, ["queued", "running"])))
    .returning({ storageKey: imports.storageKey });
  if (row) await deleteObject(row.storageKey).catch(() => undefined);
}
