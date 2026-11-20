import { getDb, mailboxes } from "@hellobox/db";
import { and, eq, isNull } from "drizzle-orm";

type Removable = { removedAt: Date | string | null };

// Why nothing can be sent from a mailbox, or null when it can send.
export function sendBlockedReason(mailbox: Removable & { isCatchAll?: boolean }, domain: Removable) {
  if (mailbox.isCatchAll) return "This mail was sent to an address that has no mailbox. Add the mailbox in settings to reply from it.";
  if (mailbox.removedAt) return "This mailbox was deleted. Add it again in settings to send from it.";
  if (domain.removedAt) return "This mailbox's domain was removed from HelloBox. Add it again to send from it.";
  return null;
}

// Deletes a mailbox from HelloBox and keeps its mail. Access stays as it was, so a
// personal mailbox's conversations are still read by its owner only.
export async function removeMailbox(workspaceId: string, mailboxId: string) {
  const [removed] = await getDb()
    .update(mailboxes)
    .set({ removedAt: new Date() })
    .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.workspaceId, workspaceId), isNull(mailboxes.removedAt)))
    .returning({ id: mailboxes.id, address: mailboxes.address, personalUserId: mailboxes.personalUserId });
  return removed ?? null;
}
