import { getDb, connections, workspaces } from "@hellobox/db";
import { enqueueWorkspacePurge } from "@hellobox/queue";
import { eq } from "drizzle-orm";
import { tearDownConnection } from "./connections";

// Deleting the row removes everything in the database. Stored files go through a job,
// because a workspace can hold far more of them than one request should wait for.
export async function destroyWorkspace(workspaceId: string) {
  const db = getDb();
  const linked = await db
    .select()
    .from(connections)
    .where(eq(connections.workspaceId, workspaceId));
  // These need the connection's credentials, so they go first.
  await Promise.all(linked.map(tearDownConnection));
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await enqueueWorkspacePurge(workspaceId);
}

// A platform admin suspended it. Mail that was queued before then doesn't go out.
export async function isWorkspaceSuspended(workspaceId: string) {
  const [row] = await getDb()
    .select({ suspendedAt: workspaces.suspendedAt })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  return Boolean(row?.suspendedAt);
}
