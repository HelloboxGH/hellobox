import { getEnv } from "@hellobox/config";
import { getDb, messages, senderLists, threads } from "@hellobox/db";
import Redis from "ioredis";
import { and, eq, inArray, like, lt, notInArray, or } from "drizzle-orm";
import { hashReputationKey, isSharedProvider, reputationKey } from "./reputation";
import { domainOf } from "./threading";

// Anyone can send a workspace mail, so nobody may fill its storage that way. Mail that
// looks like an attack is quarantined: it goes to Spam, doesn't count toward storage, and
// is deleted after a day unless someone keeps it. Past a hard limit it isn't stored at all.
// A legitimate sender that writes a lot (CI, alerts) is safe once the workspace knows it:
// see knownSender.

export const QUARANTINE_HOURS = 24;

export const FLOOD_LIMITS = {
  // One new sender (an address on a shared provider, else a whole domain) to one workspace.
  senderQuarantine: { max: 30, seconds: 600 },
  senderDrop: { max: 200, seconds: 3_600 },
  // Mail to addresses that have no mailbox, per workspace.
  unknownDrop: { max: 300, seconds: 3_600 },
  // Bytes of quarantined mail a workspace keeps a day, past which more isn't stored.
  quarantineBytes: { max: 500 * 1024 * 1024, seconds: 86_400 },
} as const;

export type FloodVerdict =
  | { kind: "normal" }
  | { kind: "quarantine"; reason: string }
  | { kind: "drop"; reason: string };

type Counts = { sender: number; senderHour: number; unknown: number; quarantinedBytes: number };

// What to do with the email, from the counters. Pure, so the limits are easy to test.
export function floodVerdict(counts: Counts, input: { unknownRecipient: boolean; knownSender: boolean }): FloodVerdict {
  if (counts.quarantinedBytes >= FLOOD_LIMITS.quarantineBytes.max && (input.unknownRecipient || !input.knownSender)) {
    return { kind: "drop", reason: "quarantine full for today" };
  }
  if (input.unknownRecipient) {
    if (counts.unknown > FLOOD_LIMITS.unknownDrop.max) return { kind: "drop", reason: "flood of mail to unknown addresses" };
    return { kind: "quarantine", reason: "unknown recipient" };
  }
  if (input.knownSender) return { kind: "normal" };
  if (counts.senderHour > FLOOD_LIMITS.senderDrop.max) return { kind: "drop", reason: "sender flood" };
  if (counts.sender > FLOOD_LIMITS.senderQuarantine.max) return { kind: "quarantine", reason: "sender flood" };
  return { kind: "normal" };
}

let redis: Redis | undefined;
const getRedis = () => (redis ??= new Redis(getEnv().REDIS_URL));

const keys = (workspaceId: string, senderHash: string) => ({
  sender: `flood:${workspaceId}:sender:${senderHash}`,
  senderHour: `flood:${workspaceId}:sender-hour:${senderHash}`,
  unknown: `flood:${workspaceId}:unknown`,
  quarantinedBytes: `flood:${workspaceId}:quarantine-bytes`,
});

// A sender the workspace already trusts: one it allowed, or one whose mail it kept from
// before the last day. Only asked once a sender is over a limit, so it rarely runs.
async function knownSender(workspaceId: string, fromAddress: string) {
  const key = reputationKey(fromAddress);
  if (!key) return false;
  const domain = domainOf(key);
  const db = getDb();
  const [allowed] = await db
    .select({ id: senderLists.id })
    .from(senderLists)
    .where(and(eq(senderLists.workspaceId, workspaceId), eq(senderLists.kind, "allowed"), inArray(senderLists.value, [fromAddress.toLowerCase(), domain])))
    .limit(1);
  if (allowed) return true;
  const fromMatches = isSharedProvider(domain)
    ? eq(messages.fromAddress, key)
    : or(like(messages.fromAddress, `%@${domain}`), like(messages.fromAddress, `%.${domain}`));
  const [kept] = await db
    .select({ id: messages.id })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .where(
      and(
        eq(messages.workspaceId, workspaceId),
        fromMatches,
        eq(messages.storageCounted, true),
        lt(messages.createdAt, new Date(Date.now() - 86_400_000)),
        notInArray(threads.folder, ["spam", "trash"]),
      ),
    )
    .limit(1);
  return Boolean(kept);
}

// Counts this email and decides what happens to it. Fails open: losing mail because Redis
// hiccuped would be worse than missing a flood for a moment.
export async function assessInbound(
  input: { workspaceId: string; fromAddress: string; unknownRecipient: boolean },
  client: Pick<Redis, "multi"> = getRedis(),
): Promise<FloodVerdict> {
  const senderHash = hashReputationKey(reputationKey(input.fromAddress) ?? input.fromAddress.toLowerCase()).slice(0, 32);
  const k = keys(input.workspaceId, senderHash);
  let counts: Counts;
  try {
    const results = await client
      .multi()
      .incr(k.sender)
      .expire(k.sender, FLOOD_LIMITS.senderQuarantine.seconds, "NX")
      .incr(k.senderHour)
      .expire(k.senderHour, FLOOD_LIMITS.senderDrop.seconds, "NX")
      .incrby(k.unknown, input.unknownRecipient ? 1 : 0)
      .expire(k.unknown, FLOOD_LIMITS.unknownDrop.seconds, "NX")
      .get(k.quarantinedBytes)
      .exec();
    const value = (index: number) => Number(results?.[index]?.[1] ?? 0);
    counts = { sender: value(0), senderHour: value(2), unknown: value(4), quarantinedBytes: value(6) };
  } catch (error) {
    console.error("[ingest] Couldn't check for floods, treating mail as normal:", error);
    return input.unknownRecipient ? { kind: "quarantine", reason: "unknown recipient" } : { kind: "normal" };
  }
  const overLimit = counts.sender > FLOOD_LIMITS.senderQuarantine.max || counts.quarantinedBytes >= FLOOD_LIMITS.quarantineBytes.max;
  const known = !input.unknownRecipient && overLimit ? await knownSender(input.workspaceId, input.fromAddress) : false;
  return floodVerdict(counts, { unknownRecipient: input.unknownRecipient, knownSender: known });
}

// Quarantined bytes count toward the day's cap even though they don't count as storage.
export async function recordQuarantinedBytes(workspaceId: string, bytes: number, client: Pick<Redis, "multi"> = getRedis()) {
  if (bytes <= 0) return;
  const key = `flood:${workspaceId}:quarantine-bytes`;
  await client
    .multi()
    .incrby(key, bytes)
    .expire(key, FLOOD_LIMITS.quarantineBytes.seconds, "NX")
    .exec()
    .catch((error: unknown) => console.error("[ingest] Couldn't count quarantined bytes:", error));
}
