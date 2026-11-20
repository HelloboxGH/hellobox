import { adminSessions, getDb, user } from "@hellobox/db";
import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import { createMiddleware, notFound, unauthorized } from "nezt";
import { adminEmails, bearerToken, isAdminEmail, looksLikeAdminToken, sha256 } from "./auth";

export interface PlatformAdminContext {
  admin: { userId: string; email: string; sessionId: string };
}

// Only the admin tool's bearer token works here, never a browser cookie, so a page
// can't be tricked into calling the admin API. Access is checked against
// ADMIN_EMAILS on every request, so removing an address takes effect at once.
export const requirePlatformAdmin = createMiddleware<object, PlatformAdminContext>(async ({ ctx, next }) => {
  const allowlist = adminEmails();
  // Without admins configured, the admin API doesn't exist.
  if (!allowlist.size) throw notFound("Action");
  const token = bearerToken(ctx.request?.headers.get("authorization"));
  if (!token || !looksLikeAdminToken(token)) throw unauthorized("Sign in with hellobox-admin login");
  const db = getDb();
  const now = new Date();
  const [row] = await db
    .select({
      sessionId: adminSessions.id,
      lastUsedAt: adminSessions.lastUsedAt,
      userId: user.id,
      email: user.email,
      emailVerified: user.emailVerified,
      bannedAt: user.bannedAt,
    })
    .from(adminSessions)
    .innerJoin(user, eq(user.id, adminSessions.userId))
    .where(
      and(
        eq(adminSessions.tokenHash, sha256(token)),
        isNull(adminSessions.revokedAt),
        gt(adminSessions.expiresAt, now),
      ),
    );
  if (!row || !row.emailVerified || row.bannedAt || !isAdminEmail(row.email, allowlist)) {
    throw unauthorized("Your admin session has ended. Sign in again");
  }
  if (!row.lastUsedAt || row.lastUsedAt.getTime() < now.getTime() - 60_000) {
    await db
      .update(adminSessions)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(adminSessions.id, row.sessionId),
          or(isNull(adminSessions.lastUsedAt), lt(adminSessions.lastUsedAt, new Date(now.getTime() - 60_000))),
        ),
      );
  }
  return next({
    ctx: ctx.add("admin", { userId: row.userId, email: row.email, sessionId: row.sessionId }) as never,
  });
});
