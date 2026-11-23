import {
  agentTokens,
  attachments,
  domains,
  getDb,
  labels,
  mailboxes,
  members,
  messages,
  senderLists,
  threadLabels,
  threadNotes,
  threads,
  threadUserState,
  user,
  workspaces,
} from "@hellobox/db";
import {
  assignmentNotices, countedBytes, mentionableOn, mentionedIn, notifyMentioned, domainOf, hasRemoteImages, keepQuarantinedThreads, markThreadNotificationsRead, notifyAssigned,
  publishEvent, readableMailboxIds, recordSpamReports, replaceCidImages, shownDomain, SPAM_REASONS, withdrawSpamReports,
} from "@hellobox/mail";
import { deleteObject } from "@hellobox/storage";
import { and, desc, eq, gt, inArray, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { badRequest, notFound } from "nezt";
import { z } from "zod";
import { safeAvatarUrl } from "@/core/avatar";
import { requireFeature } from "../entitlements";
import { emit } from "../events";
import { workspaceAction } from "../builder";
import { accessibleMailboxIds, type WorkspaceContext } from "../middlewares";

const PAGE_SIZE = 40;

const VIEWS = [
  "inbox", "starred", "snoozed", "sent", "archive", "spam", "trash", "all", "important", "assigned", "unassigned",
] as const;

const assignee = alias(user, "assignee");

// Tells everyone looking at the workspace that conversations changed, so their lists and
// open conversations catch up without a reload. One event per change, however many it touched.
const announce = (workspaceId: string, threadIds: string[]) =>
  publishEvent(workspaceId, { type: "thread.updated", threadId: threadIds.length === 1 ? threadIds[0] : undefined });

async function assertThreads(ctx: WorkspaceContext, ids: string[]) {
  const allowed = await accessibleMailboxIds(ctx);
  const rows = allowed.length
    ? await getDb()
        .select({ id: threads.id })
        .from(threads)
        .where(and(inArray(threads.id, ids), inArray(threads.mailboxId, allowed)))
    : [];
  if (rows.length !== new Set(ids).size) throw notFound("Conversation");
}

// Which domains' mail the inbox shows (see shownDomain). Needs mailboxes and domains joined.
export const onShownDomain = shownDomain;

// What the Inbox view lists. Needs this person's threadUserState left-joined.
export const inInbox = (now: Date) =>
  and(
    eq(threads.folder, "inbox"),
    or(isNull(threadUserState.snoozedUntil), lt(threadUserState.snoozedUntil, now)),
    sql`exists (select 1 from ${messages} where ${messages.threadId} = ${threads.id} and ${messages.direction} = 'inbound')`,
  );

export const listThreads = workspaceAction("/threads/list")
  .input(
    z.object({
      view: z.enum(VIEWS).default("inbox"),
      category: z.enum(["primary", "notifications", "purchases", "newsletters"]).optional(),
      mailboxId: z.string().optional(),
      labelId: z.string().optional(),
      q: z.string().trim().max(200).optional(),
      unreadOnly: z.boolean().optional(),
      cursor: z.iso.datetime().optional(),
    }),
  )
  .handler(async ({ input, ctx }) => {
    const db = getDb();
    const allowed = await accessibleMailboxIds(ctx);
    const scoped = input.mailboxId
      ? allowed.filter((id) => id === input.mailboxId)
      : allowed;
    if (!scoped.length) return { threads: [], nextCursor: null };

    const now = new Date();
    const notHidden = sql`${threads.folder} not in ('spam', 'trash')`;
    const hasOutbound = sql`exists (select 1 from ${messages} where ${messages.threadId} = ${threads.id} and ${messages.direction} = 'outbound')`;

    const filters: (SQL | undefined)[] = [
      eq(threads.workspaceId, ctx.workspace.id),
      inArray(threads.mailboxId, scoped),
      onShownDomain(),
    ];
    switch (input.view) {
      case "inbox":
        filters.push(inInbox(now));
        break;
      // Open work, so both follow the Inbox: archiving a conversation takes it off the list.
      case "assigned":
        filters.push(eq(threads.assignedTo, ctx.user.id), inInbox(now));
        break;
      case "unassigned":
        // Personal mailboxes can't be assigned, so they'd never leave this list.
        filters.push(isNull(threads.assignedTo), isNull(mailboxes.personalUserId), inInbox(now));
        break;
      case "starred":
        filters.push(eq(threadUserState.starred, true), notHidden);
        break;
      case "snoozed":
        filters.push(gt(threadUserState.snoozedUntil, now), notHidden);
        break;
      case "sent":
        filters.push(hasOutbound, notHidden);
        break;
      case "important":
        filters.push(eq(threads.important, true), notHidden);
        break;
      case "all":
        filters.push(notHidden);
        break;
      default:
        filters.push(eq(threads.folder, input.view));
    }
    if (input.category) filters.push(eq(threads.category, input.category));
    if (input.unreadOnly) filters.push(isNull(threadUserState.readAt));
    if (input.cursor) filters.push(lt(threads.lastMessageAt, new Date(input.cursor)));
    if (input.labelId) {
      filters.push(
        sql`exists (select 1 from ${threadLabels} where ${threadLabels.threadId} = ${threads.id} and ${threadLabels.labelId} = ${input.labelId})`,
      );
    }
    if (input.q) {
      // Full-text finds words in bodies, and trigrams tolerate typos in names and subjects.
      filters.push(
        sql`(${threads.subject} % ${input.q} or ${threads.subject} ilike ${`%${input.q}%`} or exists (
          select 1 from ${messages} where ${messages.threadId} = ${threads.id} and (
            ${messages.searchVector} @@ websearch_to_tsquery('simple', ${input.q})
            or ${messages.fromAddress} % ${input.q}
            or ${messages.fromName} % ${input.q}
          )
        ))`,
      );
    }

    const rows = await db
      .select({
        thread: threads,
        readAt: threadUserState.readAt,
        starred: threadUserState.starred,
        snoozedUntil: threadUserState.snoozedUntil,
        mailboxAddress: mailboxes.address,
        assigneeName: assignee.name,
        assigneeImage: assignee.image,
      })
      .from(threads)
      .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
      .leftJoin(domains, eq(domains.id, mailboxes.domainId))
      .leftJoin(assignee, eq(assignee.id, threads.assignedTo))
      .leftJoin(
        threadUserState,
        and(
          eq(threadUserState.threadId, threads.id),
          eq(threadUserState.userId, ctx.user.id),
        ),
      )
      .where(and(...filters))
      .orderBy(desc(threads.lastMessageAt))
      .limit(PAGE_SIZE + 1);

    const page = rows.slice(0, PAGE_SIZE);
    const ids = page.map((row) => row.thread.id);
    const labelRows = ids.length
      ? await db
          .select({ threadId: threadLabels.threadId, id: labels.id, name: labels.name, color: labels.color, icon: labels.icon })
          .from(threadLabels)
          .innerJoin(labels, eq(labels.id, threadLabels.labelId))
          .where(inArray(threadLabels.threadId, ids))
      : [];

    return {
      threads: page.map((row) => ({
        ...row.thread,
        mailboxAddress: row.mailboxAddress,
        unread: !row.readAt,
        starred: row.starred ?? false,
        snoozedUntil: row.snoozedUntil,
        labels: labelRows.filter((label) => label.threadId === row.thread.id),
        assignee:
          row.thread.assignedTo && row.assigneeName !== null
            ? { id: row.thread.assignedTo, name: row.assigneeName, image: safeAvatarUrl(row.assigneeImage) }
            : null,
      })),
      nextCursor:
        rows.length > PAGE_SIZE
          ? (page.at(-1)?.thread.lastMessageAt.toISOString() ?? null)
          : null,
    };
  });

export const getThread = workspaceAction("/threads/get")
  .input(z.object({ id: z.string() }))
  .handler(async ({ input, ctx }) => {
    await assertThreads(ctx, [input.id]);
    const db = getDb();
    const [thread] = await db.select().from(threads).where(eq(threads.id, input.id));
    if (!thread) throw notFound("Conversation");
    const [threadMessages, state, notes, threadLabelRows, imageSenders] = await Promise.all([
      db.select().from(messages).where(eq(messages.threadId, input.id)).orderBy(messages.sentAt),
      db
        .select()
        .from(threadUserState)
        .where(and(eq(threadUserState.threadId, input.id), eq(threadUserState.userId, ctx.user.id))),
      db
        .select({ id: threadNotes.id, body: threadNotes.body, mentions: threadNotes.mentions, createdAt: threadNotes.createdAt, author: user.name })
        .from(threadNotes)
        .innerJoin(user, eq(user.id, threadNotes.userId))
        .where(eq(threadNotes.threadId, input.id))
        .orderBy(threadNotes.createdAt),
      db
        .select({ id: labels.id, name: labels.name, color: labels.color, icon: labels.icon })
        .from(threadLabels)
        .innerJoin(labels, eq(labels.id, threadLabels.labelId))
        .where(eq(threadLabels.threadId, input.id)),
      db
        .select({ value: senderLists.value })
        .from(senderLists)
        .where(and(eq(senderLists.workspaceId, ctx.workspace.id), eq(senderLists.kind, "images_allowed"))),
    ]);
    const files = threadMessages.length
      ? await db
          .select()
          .from(attachments)
          .where(inArray(attachments.messageId, threadMessages.map((m) => m.id)))
      : [];
    const trusted = new Set(imageSenders.map((row) => row.value));
    const agentIds = [...new Set(threadMessages.flatMap((m) => m.agentTokenId ?? []))];
    const senderIds = [...new Set(threadMessages.flatMap((m) => m.sentByUserId ?? []))];
    const [agents, senders] = await Promise.all([
      agentIds.length
        ? db.select({ id: agentTokens.id, name: agentTokens.name }).from(agentTokens).where(inArray(agentTokens.id, agentIds))
        : [],
      senderIds.length ? db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, senderIds)) : [],
    ]);

    return {
      thread,
      starred: state[0]?.starred ?? false,
      notes,
      labels: threadLabelRows,
      messages: threadMessages.map(({ searchVector: _search, rawKey: _raw, ...message }) => {
        const own = files.filter((file) => file.messageId === message.id);
        const html = message.htmlBody
          ? replaceCidImages(message.htmlBody, (contentId) => {
              const file = own.find((f) => f.contentId === contentId);
              return file ? `/api/attachments/${file.id}?inline=1` : undefined;
            })
          : null;
        return {
          ...message,
          sentByAgent: agents.find((agent) => agent.id === message.agentTokenId)?.name ?? null,
          // The teammate who replied. Null for mail that came in, and for people who left.
          sentBy: senders.find((sender) => sender.id === message.sentByUserId)?.name ?? null,
          // Kept in Spam because no mailbox has the address it was sent to.
          toUnknownRecipient: Boolean(message.spamReasons?.includes(SPAM_REASONS.unknownRecipient)),
          htmlBody: html,
          hasRemoteImages: html ? hasRemoteImages(html) : false,
          // Sealed and not opened yet. The browser opens it with the person's key.
          locked: Boolean(message.sealedBody),
          // A sealed body is opened in the browser, which swaps cid: images for these.
          inlineImages: message.sealedBody
            ? Object.fromEntries(own.flatMap((file) => (file.contentId ? [[file.contentId, `/api/attachments/${file.id}?inline=1`]] : [])))
            : {},
          imagesAllowed:
            thread.folder !== "spam" &&
            (trusted.has(message.fromAddress) || trusted.has(domainOf(message.fromAddress))),
          attachments: own
            .filter((file) => !(file.contentId && message.htmlBody?.includes(`cid:${file.contentId}`)))
            .map((file) => ({
              id: file.id,
              contentId: file.contentId,
              filename: file.filename,
              contentType: file.contentType,
              size: file.size,
            })),
        };
      }),
    };
  });

const stateFor = (threadId: string, userId: string) => ({ threadId, userId });

// An assignee has to be able to open the conversation they're given.
async function assertCanBeAssigned(workspaceId: string, userId: string, threadIds: string[]) {
  const db = getDb();
  const [member] = await db
    .select({ userId: members.userId })
    .from(members)
    .where(and(eq(members.workspaceId, workspaceId), eq(members.userId, userId)));
  if (!member) throw badRequest("That person isn't in this workspace");
  const rows = await db
    .selectDistinct({ mailboxId: threads.mailboxId })
    .from(threads)
    .where(inArray(threads.id, threadIds));
  const allowed = new Set(await readableMailboxIds(workspaceId, userId));
  if (rows.some((row) => !allowed.has(row.mailboxId))) {
    throw badRequest("That person doesn't have access to this mailbox");
  }
}

export const updateThreads = workspaceAction("/threads/update")
  .input(
    z.object({
      ids: z.array(z.string()).min(1).max(100),
      folder: z.enum(["inbox", "archive", "spam", "trash"]).optional(),
      read: z.boolean().optional(),
      starred: z.boolean().optional(),
      important: z.boolean().optional(),
      snoozedUntil: z.iso.datetime().nullable().optional(),
      category: z.enum(["primary", "notifications", "purchases", "newsletters"]).optional(),
      assignedTo: z.string().nullable().optional(),
    }),
  )
  .handler(async ({ input, ctx }) => {
    await assertThreads(ctx, input.ids);
    const db = getDb();
    const threadPatch: Partial<typeof threads.$inferInsert> = {};
    if (input.folder) {
      threadPatch.folder = input.folder;
      threadPatch.trashedAt = input.folder === "trash" ? new Date() : null;
    }
    if (input.important !== undefined) threadPatch.important = input.important;
    if (input.category) threadPatch.category = input.category;
    let newlyAssigned: string[] = [];
    if (input.assignedTo !== undefined) {
      requireFeature(ctx, "team", "assignments", "Assigning conversations needs a paid plan");
      if (input.assignedTo) await assertCanBeAssigned(ctx.workspace.id, input.assignedTo, input.ids);
      threadPatch.assignedTo = input.assignedTo;
      const before = await db
        .select({ id: threads.id, assignedTo: threads.assignedTo })
        .from(threads)
        .where(inArray(threads.id, input.ids));
      newlyAssigned = assignmentNotices(before, input.assignedTo, ctx.user.id);
    }
    if (Object.keys(threadPatch).length) {
      await db.update(threads).set(threadPatch).where(inArray(threads.id, input.ids));
    }
    if (input.assignedTo && newlyAssigned.length) {
      await notifyAssigned({
        workspaceId: ctx.workspace.id,
        actorId: ctx.user.id,
        assignee: input.assignedTo,
        threadIds: newlyAssigned,
      });
    }
    // Moving quarantined mail to the inbox or archive keeps it. Trash still expires it.
    if (input.folder === "inbox" || input.folder === "archive") await keepQuarantinedThreads(ctx.workspace.id, input.ids);
    // Moving mail to Spam by hand counts against the sender's domain, like Report spam.
    if (input.folder === "spam") {
      const senders = await Promise.all(input.ids.map(latestSender));
      await recordSpamReports(ctx.user.id, senders.filter((sender): sender is string => !!sender));
    }

    const statePatch: Partial<typeof threadUserState.$inferInsert> = {};
    if (input.read !== undefined) statePatch.readAt = input.read ? new Date() : null;
    if (input.starred !== undefined) statePatch.starred = input.starred;
    if (input.snoozedUntil !== undefined) {
      statePatch.snoozedUntil = input.snoozedUntil ? new Date(input.snoozedUntil) : null;
    }
    if (Object.keys(statePatch).length) {
      await db
        .insert(threadUserState)
        .values(input.ids.map((id) => ({ ...stateFor(id, ctx.user.id), ...statePatch })))
        .onConflictDoUpdate({
          target: [threadUserState.threadId, threadUserState.userId],
          set: statePatch,
        });
    }
    if (input.read) await markThreadNotificationsRead(ctx.workspace.id, ctx.user.id, input.ids);
    // Read, starred and snoozed are each person's own, so only shared changes go out.
    if (Object.keys(threadPatch).length) await announce(ctx.workspace.id, input.ids);
    return { updated: input.ids.length };
  });

async function latestSender(threadId: string) {
  const [latest] = await getDb()
    .select({ from: messages.fromAddress })
    .from(messages)
    .where(and(eq(messages.threadId, threadId), eq(messages.direction, "inbound")))
    .orderBy(desc(messages.sentAt))
    .limit(1);
  return latest?.from ?? null;
}

// Moves the conversations. Not spam also allows their senders; spam only stops allowing
// them; blocking is the person's own choice, offered after with /threads/block-sender.
export const reportSender = workspaceAction("/threads/report-sender")
  .input(z.object({ ids: z.array(z.string()).min(1).max(100), verdict: z.enum(["spam", "not_spam"]) }))
  .handler(async ({ input, ctx }) => {
    await assertThreads(ctx, input.ids);
    const db = getDb();
    const found = await Promise.all(input.ids.map(latestSender));
    const senders = [...new Set(found.filter((sender): sender is string => !!sender))];
    if (senders.length) {
      await db
        .delete(senderLists)
        .where(
          and(
            eq(senderLists.workspaceId, ctx.workspace.id),
            eq(senderLists.kind, input.verdict === "spam" ? "allowed" : "blocked"),
            inArray(senderLists.value, senders),
          ),
        );
      if (input.verdict === "not_spam") {
        await db
          .insert(senderLists)
          .values(senders.map((value) => ({ workspaceId: ctx.workspace.id, kind: "allowed" as const, value })))
          .onConflictDoNothing();
      }
      // Every report raises the domain's spam score across HelloBox; Not spam takes it back.
      if (input.verdict === "spam") await recordSpamReports(ctx.user.id, senders);
      else await withdrawSpamReports(ctx.user.id, senders);
    }
    await db
      .update(threads)
      .set({ folder: input.verdict === "spam" ? "spam" : "inbox", trashedAt: null })
      .where(inArray(threads.id, input.ids));
    if (input.verdict === "not_spam") await keepQuarantinedThreads(ctx.workspace.id, input.ids);
    return { ok: true, senders };
  });

// Sends the sender's future mail straight to Spam, for the whole workspace. Admins undo
// it in Settings, under Rules.
export const blockSender = workspaceAction("/threads/block-sender")
  .input(z.object({ threadId: z.string() }))
  .handler(async ({ input, ctx }) => {
    await assertThreads(ctx, [input.threadId]);
    const sender = await latestSender(input.threadId);
    if (!sender) throw badRequest("This conversation has no sender to block");
    const db = getDb();
    await db
      .delete(senderLists)
      .where(
        and(eq(senderLists.workspaceId, ctx.workspace.id), eq(senderLists.kind, "allowed"), eq(senderLists.value, sender)),
      );
    await db
      .insert(senderLists)
      .values({ workspaceId: ctx.workspace.id, kind: "blocked", value: sender })
      .onConflictDoNothing();
    await emit(ctx, "sender.blocked", sender);
    return { ok: true, sender };
  });

export const allowSenderImages = workspaceAction("/threads/allow-images")
  .input(z.object({ address: z.email() }))
  .handler(async ({ input, ctx }) => {
    await getDb()
      .insert(senderLists)
      .values({
        workspaceId: ctx.workspace.id,
        kind: "images_allowed",
        value: input.address.toLowerCase(),
      })
      .onConflictDoNothing();
    return { ok: true };
  });

export const deleteThreadsForever = workspaceAction("/threads/delete")
  .input(z.object({ ids: z.array(z.string()).min(1).max(100) }))
  .handler(async ({ input, ctx }) => {
    await assertThreads(ctx, input.ids);
    await purgeThreads(ctx.workspace.id, input.ids);
    return { deleted: input.ids.length };
  });

async function purgeThreads(workspaceId: string, ids: string[]) {
  const db = getDb();
  const [files, rawKeys] = await Promise.all([
    db
      .select({ key: attachments.storageKey, size: attachments.size, counted: messages.storageCounted })
      .from(attachments)
      .innerJoin(messages, eq(messages.id, attachments.messageId))
      .where(inArray(messages.threadId, ids)),
    db
      .select({ raw: messages.rawKey, size: messages.rawSize, counted: messages.storageCounted })
      .from(messages)
      .where(inArray(messages.threadId, ids)),
  ]);
  await Promise.all(
    [...files.map((file) => file.key), ...rawKeys.flatMap((row) => row.raw ?? [])].map(deleteObject),
  );
  const freed = countedBytes(files, rawKeys);
  await db.transaction(async (tx) => {
    await tx.delete(threads).where(and(eq(threads.workspaceId, workspaceId), inArray(threads.id, ids)));
    await tx
      .update(workspaces)
      .set({ storageBytesUsed: sql`greatest(${workspaces.storageBytesUsed} - ${freed}, 0)` })
      .where(eq(workspaces.id, workspaceId));
  });
}

export const setThreadLabel = workspaceAction("/threads/label")
  .input(z.object({ ids: z.array(z.string()).min(1).max(100), labelId: z.string(), applied: z.boolean() }))
  .handler(async ({ input, ctx }) => {
    await assertThreads(ctx, input.ids);
    const db = getDb();
    const [label] = await db
      .select({ id: labels.id })
      .from(labels)
      .where(and(eq(labels.id, input.labelId), eq(labels.workspaceId, ctx.workspace.id)));
    if (!label) throw notFound("Label");
    if (input.applied) {
      await db
        .insert(threadLabels)
        .values(input.ids.map((threadId) => ({ threadId, labelId: input.labelId })))
        .onConflictDoNothing();
    } else {
      await db
        .delete(threadLabels)
        .where(and(inArray(threadLabels.threadId, input.ids), eq(threadLabels.labelId, input.labelId)));
    }
    await announce(ctx.workspace.id, input.ids);
    return { ok: true };
  });

export const addThreadNote = workspaceAction("/threads/note")
  .input(z.object({ threadId: z.string(), body: z.string().trim().min(1).max(5000) }))
  .handler(async ({ input, ctx }) => {
    await assertThreads(ctx, [input.threadId]);
    // "@Full Name" mentions anyone who can read the conversation, and tells them.
    const people = await mentionableOn(ctx.workspace.id, input.threadId);
    const mentions = mentionedIn(input.body, people, ctx.user.id);
    const [note] = await getDb()
      .insert(threadNotes)
      .values({ threadId: input.threadId, userId: ctx.user.id, body: input.body, mentions })
      .returning({ id: threadNotes.id });
    await notifyMentioned({
      workspaceId: ctx.workspace.id,
      actorId: ctx.user.id,
      threadId: input.threadId,
      noteId: note!.id,
      userIds: mentions,
    });
    await announce(ctx.workspace.id, [input.threadId]);
    return { ok: true, mentioned: mentions.length };
  });

export const threadActions = {
  "/threads/list": listThreads,
  "/threads/get": getThread,
  "/threads/update": updateThreads,
  "/threads/report-sender": reportSender,
  "/threads/block-sender": blockSender,
  "/threads/allow-images": allowSenderImages,
  "/threads/delete": deleteThreadsForever,
  "/threads/label": setThreadLabel,
  "/threads/note": addThreadNote,
};
