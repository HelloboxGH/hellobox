import { attachments, getDb, messages, threads, workspaces } from "@hellobox/db";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";

// Someone moved quarantined conversations out of Spam, so they stay: they stop expiring and
// their files count toward storage from now on, like any other mail.
export async function keepQuarantinedThreads(workspaceId: string, threadIds: string[]) {
  if (!threadIds.length) return;
  await getDb().transaction(async (tx) => {
    const kept = await tx
      .update(threads)
      .set({ expiresAt: null })
      .where(and(eq(threads.workspaceId, workspaceId), inArray(threads.id, threadIds), isNotNull(threads.expiresAt)))
      .returning({ id: threads.id });
    if (!kept.length) return;
    const counted = await tx
      .update(messages)
      .set({ storageCounted: true })
      .where(and(inArray(messages.threadId, kept.map((row) => row.id)), eq(messages.storageCounted, false)))
      .returning({ id: messages.id, rawSize: messages.rawSize });
    if (!counted.length) return;
    const [files] = await tx
      .select({ bytes: sql<number>`coalesce(sum(${attachments.size}), 0)::float8` })
      .from(attachments)
      .where(inArray(attachments.messageId, counted.map((row) => row.id)));
    const bytes = counted.reduce((total, row) => total + row.rawSize, 0) + (files?.bytes ?? 0);
    if (bytes > 0) {
      await tx
        .update(workspaces)
        .set({ storageBytesUsed: sql`${workspaces.storageBytesUsed} + ${bytes}` })
        .where(eq(workspaces.id, workspaceId));
    }
  });
}

// What deleting these messages gives back: only files that were counted to begin with.
export function countedBytes(
  files: { size: number; counted: boolean }[],
  raws: { size: number; counted: boolean }[],
) {
  return [...files, ...raws].reduce((total, row) => total + (row.counted ? row.size : 0), 0);
}
