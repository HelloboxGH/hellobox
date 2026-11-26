import { getDb, supportConversations, threads } from "@hellobox/db";
import { and, eq, inArray, ne } from "drizzle-orm";
import { publishEvent } from "../realtime";
import { recordSupportEvent } from "./webhooks";

export const SUPPORT_STATUSES = ["open", "in_progress", "solved"] as const;
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];

/** Sets the status. Solved also archives, and reopening brings the conversation back. */
export async function setSupportStatus(
  conversationIds: string[],
  status: SupportStatus,
  publish: typeof publishEvent = publishEvent,
) {
  if (!conversationIds.length) return [];
  const changed = await getDb().transaction(async (tx) => {
    const before = await tx
      .select()
      .from(supportConversations)
      .where(and(inArray(supportConversations.id, conversationIds), ne(supportConversations.status, status)))
      .for("update");
    if (!before.length) return [];
    await tx.update(supportConversations).set({ status }).where(inArray(supportConversations.id, before.map((row) => row.id)));
    const move = async (rows: typeof before, from: "inbox" | "archive", to: "inbox" | "archive") => {
      if (!rows.length) return;
      // Spam and Trash stay put.
      await tx.update(threads).set({ folder: to }).where(and(inArray(threads.id, rows.map((row) => row.threadId)), eq(threads.folder, from)));
    };
    for (const row of before) await recordSupportEvent(tx, row, "conversation.status_changed", { status });
    if (status === "solved") await move(before, "inbox", "archive");
    else await move(before.filter((row) => row.status === "solved"), "archive", "inbox");
    return before.map(({ id, threadId, workspaceId, status: previous }) => ({ id, threadId, workspaceId, status: previous }));
  });
  const byWorkspace = Map.groupBy(changed, (row) => row.workspaceId);
  await Promise.all([...byWorkspace].map(([workspaceId, rows]) =>
    publish(workspaceId, { type: "thread.updated", threadId: rows.length === 1 ? rows[0]!.threadId : undefined }),
  )).catch((error: unknown) => console.error("[support] Couldn't announce a status:", error));
  return changed;
}
