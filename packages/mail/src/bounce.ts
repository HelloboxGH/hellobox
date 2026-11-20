import { getEnv } from "@hellobox/config";
import type { Authentication, MailProvider } from "@hellobox/providers";
import Redis from "ioredis";
import { hashReputationKey, isSharedProvider } from "./reputation";
import { domainOf, parseAddress } from "./threading";

// Mail to an address with no mailbox is kept in Spam and, when it's safe, answered with a
// bounce so a real sender learns the address is wrong. We only hear about mail after the
// provider accepted it, so a bounce is a new email, not an SMTP rejection. Sending one to
// a forged sender is backscatter, which gets domains blocklisted, so we're strict.

type Headers = Record<string, string | string[]>;

const header = (headers: Headers, name: string) => {
  const value = headers[name.toLowerCase()];
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
};

const MACHINE_SENDER = /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounces?|notifications?)([+._-]|$)/i;

export type BounceDecision = { send: true; to: string } | { send: false; reason: string };

export function bounceDecision(input: {
  from: string;
  headers: Headers;
  authentication: Authentication | null | undefined;
  // The scanner or a rule thinks it's spam regardless of where it was going.
  looksLikeSpam: boolean;
  sendingEnabled: boolean;
}): BounceDecision {
  if (!input.sendingEnabled) return { send: false, reason: "Sending is off for this domain" };
  if (input.looksLikeSpam) return { send: false, reason: "Looks like spam" };
  // A forged sender would get the bounce, so the sender has to prove the address is theirs.
  const auth = input.authentication;
  if (auth?.dmarc !== "pass" && !(auth?.spf === "pass" && auth?.dkim === "pass")) {
    return { send: false, reason: "Sender isn't authenticated" };
  }
  // A null Return-Path marks a bounce itself. Answering it could loop.
  const returnPath = header(input.headers, "return-path").replace(/^<|>$/g, "");
  if (input.headers["return-path"] !== undefined && !returnPath) return { send: false, reason: "Null sender" };
  // Only ever the From address: it's what DMARC vouched for. DMARC can pass on DKIM alone
  // while the Return-Path names anyone, so following it would let a sender aim our bounces
  // at a third party.
  const to = parseAddress(input.from).address.toLowerCase();
  if (!to.includes("@") || MACHINE_SENDER.test(to.slice(0, to.indexOf("@")))) {
    return { send: false, reason: "Automated sender" };
  }
  // Never answer automated mail: lists, auto-replies and bulk sends.
  const autoSubmitted = header(input.headers, "auto-submitted").toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") return { send: false, reason: "Automated mail" };
  if (/^(bulk|list|junk|auto_reply)$/i.test(header(input.headers, "precedence"))) {
    return { send: false, reason: "Bulk mail" };
  }
  if (header(input.headers, "list-id") || header(input.headers, "list-unsubscribe")) {
    return { send: false, reason: "Mailing list" };
  }
  return { send: true, to };
}

// Caps on bounces, so nobody can use them to spend a workspace's sending credits or its
// domain's reputation. Each would-be bounce needs room in every bucket that applies, and
// takes it from all of them at once. Over a cap the mail still lands in Spam, it just isn't
// answered. Sender buckets stop one sender. The domain and workspace buckets stop a sender
// who keeps changing address or domain, and bound the worst case for a workspace.
export const BOUNCE_LIMITS = {
  // One per sender address a day, so retries and repeat typos get one answer.
  sender: { max: 1, seconds: 86_400 },
  // A domain with many senders, like a batch of fresh addresses at the attacker's domain.
  // Shared providers like gmail.com aren't one sender, so they're only capped per address.
  senderDomain: { max: 3, seconds: 86_400 },
  // Each of our receiving domains, then the whole workspace.
  domainHour: { max: 10, seconds: 3_600 },
  workspaceDay: { max: 50, seconds: 86_400 },
} as const;

type Bucket = { key: string; max: number; seconds: number };

export function bounceBuckets(input: { to: string; domainId: string; workspaceId: string }): Bucket[] {
  const senderDomain = domainOf(input.to);
  const hash = (value: string) => hashReputationKey(value).slice(0, 32);
  return [
    { key: `bounce:sender:${hash(input.to)}`, ...BOUNCE_LIMITS.sender },
    ...(isSharedProvider(senderDomain) ? [] : [{ key: `bounce:sender-domain:${hash(senderDomain)}`, ...BOUNCE_LIMITS.senderDomain }]),
    { key: `bounce:domain:${input.domainId}`, ...BOUNCE_LIMITS.domainHour },
    { key: `bounce:workspace:${input.workspaceId}`, ...BOUNCE_LIMITS.workspaceDay },
  ];
}

// Checks every bucket, then counts against all of them only if each has room, so a refusal
// never uses up a slot. Runs as one script, so parallel ingest jobs can't both slip under.
const CLAIM = `
for i = 1, #KEYS do
  local used = tonumber(redis.call("GET", KEYS[i]) or "0")
  if used >= tonumber(ARGV[i * 2 - 1]) then return i end
end
for i = 1, #KEYS do
  if redis.call("INCR", KEYS[i]) == 1 then redis.call("EXPIRE", KEYS[i], tonumber(ARGV[i * 2])) end
end
return 0`;

let redis: Redis | undefined;
const getRedis = () => (redis ??= new Redis(getEnv().REDIS_URL));

// Null when the bounce may go, or the key of the full bucket. Fails closed: without Redis
// we can't count, so nothing is sent.
export async function claimBounce(buckets: Bucket[], client: Pick<Redis, "eval"> = getRedis()) {
  try {
    const args = buckets.flatMap((bucket) => [bucket.max, bucket.seconds]);
    const full = Number(await client.eval(CLAIM, buckets.length, ...buckets.map((bucket) => bucket.key), ...args));
    return full === 0 ? null : (buckets[full - 1]?.key ?? "unknown");
  } catch (error) {
    console.error("[ingest] Couldn't check bounce limits, not bouncing:", error);
    return "unavailable";
  }
}

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

export function bounceMessage(input: { recipient: string; subject: string; sentAt: Date; messageId: string | null }) {
  const domain = domainOf(input.recipient);
  const lines = [
    `Your message to ${input.recipient} couldn't be delivered: that address doesn't exist at ${domain}.`,
    "Check the address for typos, or reach the person another way.",
    "",
    `Subject: ${input.subject || "(no subject)"}`,
    `Sent: ${input.sentAt.toUTCString()}`,
    "",
    "Status: 5.1.1 (bad destination mailbox address)",
  ];
  return {
    subject: `Undeliverable: ${input.subject || "(no subject)"}`.slice(0, 250),
    text: lines.join("\n"),
    html: `<div style="font:14px/1.6 system-ui,sans-serif">${lines.map((line) => (line ? `<p style="margin:0 0 4px">${escape(line)}</p>` : "<br>")).join("")}</div>`,
    headers: {
      "Auto-Submitted": "auto-replied",
      "X-Failed-Recipients": input.recipient,
      ...(input.messageId ? { "In-Reply-To": input.messageId, References: input.messageId } : {}),
    },
  };
}

// Best effort: a failed bounce mustn't fail the ingest job and retry the whole email.
export async function sendBounce(
  provider: MailProvider,
  input: { to: string; recipient: string; subject: string; sentAt: Date; messageId: string | null; idempotencyKey: string },
) {
  const message = bounceMessage(input);
  try {
    await provider.send(
      {
        from: `Mail Delivery System <mailer-daemon@${domainOf(input.recipient)}>`,
        to: [input.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
        headers: message.headers,
        tags: { kind: "bounce" },
      },
      input.idempotencyKey,
    );
    return true;
  } catch (error) {
    console.error(`[ingest] Couldn't bounce mail for ${input.recipient}:`, error);
    return false;
  }
}
