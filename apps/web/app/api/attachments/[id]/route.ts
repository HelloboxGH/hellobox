import { attachments, getDb, members, messages, threads } from "@hellobox/db";
import { canReadMailbox } from "@hellobox/mail";
import { signedDownloadUrl } from "@hellobox/storage";
import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { getAuth } from "@/core/auth";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;
  const db = getDb();
  const [row] = await db
    .select({
      file: attachments,
      mailboxId: threads.mailboxId,
      workspaceId: attachments.workspaceId,
    })
    .from(attachments)
    .innerJoin(messages, eq(messages.id, attachments.messageId))
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .innerJoin(
      members,
      and(
        eq(members.workspaceId, attachments.workspaceId),
        eq(members.userId, session.user.id),
      ),
    )
    .where(eq(attachments.id, id));
  if (!row) return new Response("Not found", { status: 404 });
  if (!(await canReadMailbox(row.workspaceId, session.user.id, row.mailboxId))) {
    return new Response("Not found", { status: 404 });
  }
  return Response.redirect(
    await signedDownloadUrl(
      row.file.storageKey,
      row.file.filename,
      row.file.contentType,
    ),
  );
}
