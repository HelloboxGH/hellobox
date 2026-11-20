import { getDb, members, workspaces } from "@hellobox/db";
import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";

// How often lastActiveAt is written for a busy workspace. Plenty for a 90-day rule.
const TOUCH_EVERY_MS = 60 * 60 * 1000;

const stale = (now: Date) =>
  or(isNull(workspaces.lastActiveAt), lt(workspaces.lastActiveAt, new Date(now.getTime() - TOUCH_EVERY_MS)));

// Someone used the workspace: the app, the API, an agent, or mail sent from it. Never
// for mail arriving. Failing to record it must never fail what they were doing.
// Remembered here too, so a busy workspace doesn't cost a write on every request.
const touched = new Map<string, number>();

export async function touchWorkspace(workspaceId: string) {
  const now = new Date();
  if (now.getTime() - (touched.get(workspaceId) ?? 0) < TOUCH_EVERY_MS) return;
  if (touched.size > 10_000) touched.clear();
  touched.set(workspaceId, now.getTime());
  await getDb()
    .update(workspaces)
    .set({ lastActiveAt: now })
    .where(and(eq(workspaces.id, workspaceId), stale(now)))
    .catch((error: unknown) => console.error("[activity] Couldn't record activity:", error));
}

// A member signing in counts for every workspace they're in.
export async function touchMemberWorkspaces(userId: string) {
  const now = new Date();
  const mine = getDb().select({ id: members.workspaceId }).from(members).where(eq(members.userId, userId));
  await getDb()
    .update(workspaces)
    .set({ lastActiveAt: now })
    .where(and(inArray(workspaces.id, mine), stale(now)))
    .catch((error: unknown) => console.error("[activity] Couldn't record activity:", error));
}
