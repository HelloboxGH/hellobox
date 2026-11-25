import { createHash, randomBytes } from "node:crypto";
import { connections, domains, getDb, mailboxes, supportInboxes, supportKeys, workspaces } from "@hellobox/db";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { sendBlockedReason } from "../mailboxes";

const PREFIX = "hbs_";
// Enough to tell keys apart, and useless for guessing the rest.
const SHOWN = PREFIX.length + 6;

export const hashSupportKey = (key: string) => createHash("sha256").update(key).digest("hex");

export function generateSupportKey() {
  const key = `${PREFIX}${randomBytes(32).toString("base64url")}`;
  return { key, hash: hashSupportKey(key), prefix: key.slice(0, SHOWN) };
}

// Saves a database lookup for strings that were never one of our keys.
export const looksLikeSupportKey = (key: string) =>
  key.startsWith(PREFIX) && /^[A-Za-z0-9_-]{43}$/.test(key.slice(PREFIX.length));

const inboxRow = {
  inbox: supportInboxes,
  mailbox: mailboxes,
  domain: domains,
  connectionStatus: connections.status,
  workspace: { id: workspaces.id, suspendedAt: workspaces.suspendedAt, storageBytesUsed: workspaces.storageBytesUsed },
};

export type SupportInbox = NonNullable<Awaited<ReturnType<typeof findSupportInbox>>>;

const withInbox = <T extends object>(extra: T) => ({ ...inboxRow, ...extra });

/** A support inbox with what decides whether it takes messages. */
export async function findSupportInbox(inboxId: string) {
  const [row] = await getDb()
    .select(inboxRow)
    .from(supportInboxes)
    .innerJoin(mailboxes, eq(mailboxes.id, supportInboxes.mailboxId))
    .leftJoin(domains, eq(domains.id, mailboxes.domainId))
    .leftJoin(connections, eq(connections.id, domains.connectionId))
    .innerJoin(workspaces, eq(workspaces.id, supportInboxes.workspaceId))
    .where(eq(supportInboxes.id, inboxId));
  return row ?? null;
}

/** The inbox a key belongs to, or null when there's no such key or it was revoked. */
export async function findSupportKey(key: string) {
  if (!looksLikeSupportKey(key)) return null;
  const [row] = await getDb()
    .select(withInbox({ keyId: supportKeys.id }))
    .from(supportKeys)
    .innerJoin(supportInboxes, eq(supportInboxes.id, supportKeys.inboxId))
    .innerJoin(mailboxes, eq(mailboxes.id, supportInboxes.mailboxId))
    .leftJoin(domains, eq(domains.id, mailboxes.domainId))
    .leftJoin(connections, eq(connections.id, domains.connectionId))
    .innerJoin(workspaces, eq(workspaces.id, supportInboxes.workspaceId))
    .where(and(eq(supportKeys.keyHash, hashSupportKey(key)), isNull(supportKeys.revokedAt)));
  return row ?? null;
}

// A write a minute at most, however busy the key is.
export async function touchSupportKey(keyId: string) {
  const now = new Date();
  await getDb()
    .update(supportKeys)
    .set({ lastUsedAt: now })
    .where(
      and(
        eq(supportKeys.id, keyId),
        or(isNull(supportKeys.lastUsedAt), lt(supportKeys.lastUsedAt, new Date(now.getTime() - 60_000))),
      ),
    );
}

/** Why the inbox takes no messages now, or null. Nobody could answer one it took. */
export function supportInboxProblem(row: Omit<SupportInbox, "inbox">) {
  if (row.workspace.suspendedAt) return "This workspace is suspended";
  const stopped = sendBlockedReason(row.mailbox, row.domain);
  if (stopped) return stopped;
  if (row.mailbox.personalUserId) return "This mailbox is personal now. Share it again in HelloBox to receive support messages";
  if (!row.domain?.enabled) return "This mailbox's domain is switched off in HelloBox";
  if (!row.domain.sendingEnabled || row.connectionStatus === "disconnected") {
    return "This mailbox's domain can't send. Check it in HelloBox settings";
  }
  return null;
}
