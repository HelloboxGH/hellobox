import { domains, getDb, mailboxes, mailboxMembers, members } from "@hellobox/db";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { shownDomain } from "./domains";

// Who reads a mailbox: the people it's assigned to, or its one owner when it's personal.
// The workspace role doesn't widen this, so admins only read what they're given.

// Mail on a domain that's switched off is hidden until it's back on (see shownDomain): not
// just from lists, but from every way in, so opening a conversation, an attachment, the AI
// or an agent can't reach it either. A removed domain's mail stays readable.
export async function readableMailboxIds(workspaceId: string, userId: string) {
  const db = getDb();
  const [assigned, personal] = await Promise.all([
    db
      .select({ id: mailboxes.id })
      .from(mailboxMembers)
      .innerJoin(mailboxes, eq(mailboxes.id, mailboxMembers.mailboxId))
      .leftJoin(domains, eq(domains.id, mailboxes.domainId))
      .where(
        and(
          eq(mailboxMembers.userId, userId),
          eq(mailboxes.workspaceId, workspaceId),
          isNull(mailboxes.personalUserId),
          shownDomain(),
        ),
      ),
    db
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .leftJoin(domains, eq(domains.id, mailboxes.domainId))
      .where(and(eq(mailboxes.workspaceId, workspaceId), eq(mailboxes.personalUserId, userId), shownDomain())),
  ]);
  return [...new Set([...assigned, ...personal].map((row) => row.id))];
}

export async function canReadMailbox(workspaceId: string, userId: string, mailboxId: string) {
  const [row] = await getDb()
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .leftJoin(domains, eq(domains.id, mailboxes.domainId))
    .leftJoin(mailboxMembers, and(eq(mailboxMembers.mailboxId, mailboxes.id), eq(mailboxMembers.userId, userId)))
    .where(
      and(
        eq(mailboxes.id, mailboxId),
        eq(mailboxes.workspaceId, workspaceId),
        or(
          eq(mailboxes.personalUserId, userId),
          and(isNull(mailboxes.personalUserId), eq(mailboxMembers.userId, userId)),
        ),
        shownDomain(),
      ),
    );
  return Boolean(row);
}

// New shared mailboxes start with the owner and admins, who hand them on from there.
export async function shareWithAdmins(workspaceId: string, mailboxIds: string[], roles: ("owner" | "admin")[] = ["owner", "admin"]) {
  if (!mailboxIds.length) return;
  const db = getDb();
  const people = await db
    .select({ userId: members.userId })
    .from(members)
    .where(and(eq(members.workspaceId, workspaceId), inArray(members.role, roles)));
  if (!people.length) return;
  await db
    .insert(mailboxMembers)
    .values(mailboxIds.flatMap((mailboxId) => people.map(({ userId }) => ({ mailboxId, userId }))))
    .onConflictDoNothing();
}

// When someone leaves, their personal mailboxes stay with the workspace: they become
// shared and go to the owner only, since nobody else could read them before. Mail that was
// sealed to the person's key stays sealed; new mail is stored in the clear.
export async function releasePersonalMailboxes(workspaceId: string, userId: string) {
  const released = await getDb()
    .update(mailboxes)
    .set({ personalUserId: null, encrypted: false })
    .where(and(eq(mailboxes.workspaceId, workspaceId), eq(mailboxes.personalUserId, userId)))
    .returning({ id: mailboxes.id });
  await shareWithAdmins(workspaceId, released.map((row) => row.id), ["owner"]);
}
