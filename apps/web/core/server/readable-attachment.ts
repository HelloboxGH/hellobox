import { attachments, getDb, members, messages, threads } from "@hellobox/db";
import { canReadMailbox } from "@hellobox/mail";
import { and, eq } from "drizzle-orm";

/** The file, when the person can read the mailbox it's in. */
export async function readableAttachment(id: string, userId: string) {
  const [row] = await getDb()
    .select({ file: attachments, mailboxId: threads.mailboxId, workspaceId: attachments.workspaceId })
    .from(attachments)
    .innerJoin(messages, eq(messages.id, attachments.messageId))
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .innerJoin(members, and(eq(members.workspaceId, attachments.workspaceId), eq(members.userId, userId)))
    .where(eq(attachments.id, id));
  if (!row || !(await canReadMailbox(row.workspaceId, userId, row.mailboxId))) return null;
  return row.file;
}
