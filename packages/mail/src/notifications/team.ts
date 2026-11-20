import {
  getDb, mailboxes, notificationSettings, threadNotes, threads, user, userNotifications, workspaces,
} from "@hellobox/db";
import { sendAppEmail, TeamActivity, type TeamActivityItem, teamActivitySubject } from "@hellobox/email";
import { enqueueTeamEmail } from "@hellobox/queue";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { createElement } from "react";
import { readableMailboxIds } from "../mailbox-access";
import { inboxUrl, readersOf, threadUrl } from "./notify";

// Notifications about what teammates do, as opposed to new mail: they show in the app
// (the bell in the sidebar footer) and are emailed, since they ask someone to act.

/**
 * Which conversations tell the new assignee: only ones that really change hands, and never
 * when someone assigns themselves.
 */
export function assignmentNotices(
  before: { id: string; assignedTo: string | null }[],
  assignee: string | null,
  actorId: string,
) {
  if (!assignee || assignee === actorId) return [];
  return before.filter((thread) => thread.assignedTo !== assignee).map((thread) => thread.id);
}

/**
 * Who a note mentions: teammates written as "@Full Name" (any case), from the people who can
 * read the conversation, never the author. The note's text is the only source, so nobody can
 * be mentioned into a conversation they can't open.
 */
export function mentionedIn(body: string, people: { id: string; name: string }[], authorId: string) {
  const text = body.toLowerCase();
  return people
    .filter((person) => person.id !== authorId && person.name.trim())
    .filter((person) => {
      const tag = `@${person.name.trim().toLowerCase()}`;
      let at = text.indexOf(tag);
      while (at !== -1) {
        // "@Amara Okafor" mentions Amara Okafor, but "@Amara Okaforsson" doesn't.
        const next = text[at + tag.length];
        if (next === undefined || !/[\p{L}\p{N}_]/u.test(next)) return true;
        at = text.indexOf(tag, at + 1);
      }
      return false;
    })
    .map((person) => person.id);
}

/** Records "assigned to you" for each conversation, then schedules the email. */
export async function notifyAssigned(input: {
  workspaceId: string;
  actorId: string;
  assignee: string;
  threadIds: string[];
}) {
  if (!input.threadIds.length) return { created: 0 };
  const rows = await getDb()
    .insert(userNotifications)
    .values(
      input.threadIds.map((threadId) => ({
        workspaceId: input.workspaceId,
        userId: input.assignee,
        actorId: input.actorId,
        kind: "assigned" as const,
        threadId,
      })),
    )
    .returning({ id: userNotifications.id });
  await enqueueTeamEmail(input.workspaceId, input.assignee);
  return { created: rows.length };
}

/** The people a new note can mention: everyone who reads its conversation, with names. */
export async function mentionableOn(workspaceId: string, threadId: string) {
  const db = getDb();
  const [row] = await db
    .select({ id: mailboxes.id, personalUserId: mailboxes.personalUserId })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .where(and(eq(threads.id, threadId), eq(threads.workspaceId, workspaceId)));
  if (!row) return [];
  const ids = await readersOf(workspaceId, row);
  return ids.length ? db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, ids)) : [];
}

/** Records "mentioned you" for each person in a note, then schedules their emails. */
export async function notifyMentioned(input: {
  workspaceId: string;
  actorId: string;
  threadId: string;
  noteId: string;
  userIds: string[];
}) {
  if (!input.userIds.length) return { created: 0 };
  await getDb()
    .insert(userNotifications)
    .values(
      input.userIds.map((userId) => ({
        workspaceId: input.workspaceId,
        userId,
        actorId: input.actorId,
        kind: "mentioned" as const,
        threadId: input.threadId,
        noteId: input.noteId,
      })),
    );
  await Promise.all(input.userIds.map((userId) => enqueueTeamEmail(input.workspaceId, userId)));
  return { created: input.userIds.length };
}

/** Opening a conversation counts as seeing what it was about. */
export async function markThreadNotificationsRead(workspaceId: string, userId: string, threadIds: string[]) {
  if (!threadIds.length) return;
  await getDb()
    .update(userNotifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(userNotifications.workspaceId, workspaceId),
        eq(userNotifications.userId, userId),
        inArray(userNotifications.threadId, threadIds),
        isNull(userNotifications.readAt),
      ),
    );
}

const customerOf = (participants: { address: string; name?: string }[], mailbox: string) => {
  const person = participants.find((p) => p.address !== mailbox) ?? participants[0];
  if (!person) return "Unknown sender";
  return person.name ? `${person.name} <${person.address}>` : person.address;
};

const excerpt = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 280 ? `${flat.slice(0, 279)}…` : flat;
};

/**
 * The team-email job. Claims every notification for this person that hasn't been emailed or
 * seen in the app, and sends one email about the ones that still hold: they can still read
 * the conversation, and an assigned one is still theirs.
 */
export async function sendTeamEmail(workspaceId: string, userId: string) {
  const db = getDb();
  const [[workspace], [setting], [person]] = await Promise.all([
    db
      .select({ name: workspaces.name, demoExpiresAt: workspaces.demoExpiresAt, suspendedAt: workspaces.suspendedAt })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId)),
    db
      .select({ teamEmails: notificationSettings.teamEmails })
      .from(notificationSettings)
      .where(and(eq(notificationSettings.workspaceId, workspaceId), eq(notificationSettings.userId, userId))),
    db.select({ email: user.email }).from(user).where(eq(user.id, userId)),
  ]);
  // Demo sandboxes never email anyone, and some people only want these in the app.
  if (!workspace || !person || workspace.demoExpiresAt || workspace.suspendedAt) return { sent: 0 };
  if (setting && !setting.teamEmails) return { sent: 0 };

  const claimed = await db
    .update(userNotifications)
    .set({ emailedAt: new Date() })
    .where(
      and(
        eq(userNotifications.workspaceId, workspaceId),
        eq(userNotifications.userId, userId),
        isNull(userNotifications.emailedAt),
        isNull(userNotifications.readAt),
      ),
    )
    .returning({
      kind: userNotifications.kind,
      threadId: userNotifications.threadId,
      noteId: userNotifications.noteId,
      actorId: userNotifications.actorId,
      createdAt: userNotifications.createdAt,
    });
  if (!claimed.length) return { sent: 0 };

  const readable = await readableMailboxIds(workspaceId, userId);
  const threadIds = [...new Set(claimed.map((row) => row.threadId))];
  const noteIds = [...new Set(claimed.flatMap((row) => row.noteId ?? []))];
  const actorIds = [...new Set(claimed.flatMap((row) => row.actorId ?? []))];
  const [threadRows, notes, actors] = await Promise.all([
    readable.length
      ? db
          .select({
            id: threads.id,
            subject: threads.subject,
            participants: threads.participants,
            assignedTo: threads.assignedTo,
            mailbox: mailboxes.address,
          })
          .from(threads)
          .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
          .where(and(inArray(threads.id, threadIds), inArray(threads.mailboxId, readable)))
      : [],
    noteIds.length
      ? db.select({ id: threadNotes.id, body: threadNotes.body }).from(threadNotes).where(inArray(threadNotes.id, noteIds))
      : [],
    actorIds.length ? db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, actorIds)) : [],
  ]);

  const items: TeamActivityItem[] = [];
  for (const row of claimed.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const thread = threadRows.find((t) => t.id === row.threadId);
    if (!thread) continue;
    if (row.kind === "assigned" && thread.assignedTo !== userId) continue;
    const note = row.noteId ? notes.find((n) => n.id === row.noteId) : undefined;
    if (row.kind === "mentioned" && !note) continue;
    items.push({
      kind: row.kind,
      actor: actors.find((a) => a.id === row.actorId)?.name ?? null,
      subject: thread.subject,
      from: customerOf(thread.participants, thread.mailbox),
      note: note ? excerpt(note.body) : undefined,
      url: threadUrl(workspaceId, thread.id),
    });
  }
  if (!items.length) return { sent: 0 };

  const email = { workspace: workspace.name, items, url: items.length === 1 ? items[0]!.url : inboxUrl(workspaceId) };
  try {
    await sendAppEmail({
      to: person.email,
      subject: teamActivitySubject(email),
      react: createElement(TeamActivity, email),
    });
  } catch (error) {
    // Already claimed, so it isn't retried: the notification still waits in the app.
    console.error("[notify] team email failed:", error);
    return { sent: 0 };
  }
  return { sent: 1 };
}
