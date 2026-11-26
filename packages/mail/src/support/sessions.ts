import { randomBytes } from "node:crypto";
import { getDb, supportKeys, supportSessions } from "@hellobox/db";
import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import { findSupportInbox, hashSupportKey } from "./keys";

// The hosted page. The developer's server asks for a link for one signed-in customer. Its
// token works once and for 5 minutes, and becomes a session for an hour, kept only in the
// page's memory: a reload needs a new link.

const LINK_MS = 5 * 60 * 1000;
const SESSION_MS = 60 * 60 * 1000;
const LINK_PREFIX = "hst_";
const SESSION_PREFIX = "hss_";

const token = (prefix: string) => `${prefix}${randomBytes(32).toString("base64url")}`;
const looksLike = (value: string, prefix: string) => value.startsWith(prefix) && /^[A-Za-z0-9_-]{43}$/.test(value.slice(prefix.length));

export interface SessionUser {
  id: string;
  email: string;
  name?: string;
}

/** A one-time link token for this customer. */
export async function createSupportSession(row: { inbox: { id: string; workspaceId: string }; keyId: string }, user: SessionUser) {
  const link = token(LINK_PREFIX);
  const expiresAt = new Date(Date.now() + LINK_MS);
  await getDb().insert(supportSessions).values({
    workspaceId: row.inbox.workspaceId,
    inboxId: row.inbox.id,
    keyId: row.keyId,
    externalUserId: user.id,
    email: user.email,
    name: user.name,
    tokenHash: hashSupportKey(link),
    expiresAt,
  });
  return { token: link, expiresAt };
}

/** Trades a link's token for a session, once. Null when it's unknown, used or expired. */
export async function exchangeSupportSession(link: string, inboxId: string) {
  if (!looksLike(link, LINK_PREFIX)) return null;
  const now = new Date();
  const session = token(SESSION_PREFIX);
  const expiresAt = new Date(now.getTime() + SESSION_MS);
  const [row] = await getDb()
    .update(supportSessions)
    .set({ usedAt: now, sessionHash: hashSupportKey(session), sessionExpiresAt: expiresAt })
    .where(
      and(
        eq(supportSessions.tokenHash, hashSupportKey(link)),
        eq(supportSessions.inboxId, inboxId),
        isNull(supportSessions.usedAt),
        gt(supportSessions.expiresAt, now),
      ),
    )
    .returning({ id: supportSessions.id });
  return row ? { session, expiresAt } : null;
}

/** The customer and inbox behind a session, or null. A revoked key ends it. */
export async function findSupportSession(session: string) {
  if (!looksLike(session, SESSION_PREFIX)) return null;
  const [row] = await getDb()
    .select({ session: supportSessions })
    .from(supportSessions)
    .innerJoin(supportKeys, eq(supportKeys.id, supportSessions.keyId))
    .where(
      and(
        eq(supportSessions.sessionHash, hashSupportKey(session)),
        gt(supportSessions.sessionExpiresAt, new Date()),
        isNull(supportKeys.revokedAt),
      ),
    );
  if (!row) return null;
  const inbox = await findSupportInbox(row.session.inboxId);
  if (!inbox) return null;
  const { externalUserId, email, name, keyId, expiresAt: _expiresAt, sessionExpiresAt } = row.session;
  return { ...inbox, keyId, user: { id: externalUserId, email, name: name ?? undefined }, expiresAt: sessionExpiresAt! };
}

/** For maintenance. */
export async function pruneSupportSessions() {
  const now = new Date();
  await getDb()
    .delete(supportSessions)
    .where(or(lt(supportSessions.sessionExpiresAt, now), and(isNull(supportSessions.usedAt), lt(supportSessions.expiresAt, now))));
}
