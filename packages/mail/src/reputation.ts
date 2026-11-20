import { createHash } from "node:crypto";
import { domainSpamReports, getDb, mailboxes, mailboxMembers, spamExemptions } from "@hellobox/db";
import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { domainOf } from "./threading";

// How many different people have to move a domain's mail to Spam before its mail goes
// to Spam for everyone. Low enough to catch a spammer early, high enough that one or two
// people clearing out newsletters don't bury a legitimate sender.
export const SPAM_REPORT_THRESHOLD = 5;
// Reports older than this stop counting, so a domain that cleans up recovers.
export const SPAM_REPORT_WINDOW_DAYS = 180;

// Mailbox providers anyone can sign up to. Reporting one person on gmail.com mustn't
// count against everyone on gmail.com, so these are scored by full address instead.
const SHARED_PROVIDERS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "yahoo.com", "ymail.com", "rocketmail.com", "icloud.com", "me.com", "mac.com", "aol.com",
  "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.net", "gmx.de", "web.de",
  "mail.com", "yandex.com", "yandex.ru", "mail.ru", "zoho.com", "zohomail.com",
  "fastmail.com", "hey.com", "tutanota.com", "tuta.io", "qq.com", "163.com", "126.com",
  "naver.com", "orange.fr", "free.fr", "laposte.net", "libero.it", "t-online.de",
]);

export const isSharedProvider = (domain: string) => SHARED_PROVIDERS.has(domain.toLowerCase());

// What a report counts against: the sending domain, or the address on a shared provider.
export function reputationKey(fromAddress: string) {
  const address = fromAddress.trim().toLowerCase();
  if (!address.includes("@")) return null;
  const domain = domainOf(address);
  if (!domain) return null;
  return isSharedProvider(domain) ? address : domain;
}

export const hashReputationKey = (key: string) => createHash("sha256").update(key).digest("hex");

const hashesFor = (fromAddresses: string[]) => [
  ...new Set(
    fromAddresses.flatMap((address) => {
      const key = reputationKey(address);
      return key ? [hashReputationKey(key)] : [];
    }),
  ),
];

// Counts this person against the senders' domains. Reporting again only refreshes the date.
export async function recordSpamReports(userId: string, fromAddresses: string[]) {
  const hashes = hashesFor(fromAddresses);
  if (!hashes.length) return;
  await getDb()
    .insert(domainSpamReports)
    .values(hashes.map((domainHash) => ({ domainHash, userId })))
    .onConflictDoUpdate({
      target: [domainSpamReports.domainHash, domainSpamReports.userId],
      set: { reportedAt: new Date() },
    });
}

// "Not spam" takes this person's report back.
export async function withdrawSpamReports(userId: string, fromAddresses: string[]) {
  const hashes = hashesFor(fromAddresses);
  if (!hashes.length) return;
  await getDb()
    .delete(domainSpamReports)
    .where(and(eq(domainSpamReports.userId, userId), inArray(domainSpamReports.domainHash, hashes)));
}

// The sender's spam score: how many people reported its domain lately.
export async function spamReportCount(fromAddress: string) {
  const key = reputationKey(fromAddress);
  if (!key) return 0;
  const since = new Date(Date.now() - SPAM_REPORT_WINDOW_DAYS * 86_400_000);
  const [row] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(domainSpamReports)
    .where(and(eq(domainSpamReports.domainHash, hashReputationKey(key)), gt(domainSpamReports.reportedAt, since)));
  return row?.count ?? 0;
}

export const isReportedSender = (reports: number) => reports >= SPAM_REPORT_THRESHOLD;

// Lowercased bare domain, or null when it isn't one. Accepts "@example.com" and URLs.
export function normalizeExemptDomain(input: string) {
  const value = input
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^.*@/, "")
    .replace(/[/?#].*$/, "")
    .replace(/\.$/, "");
  return /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value) ? value : null;
}

// True when someone who reads this mailbox said the sender's domain never goes to Spam.
// A parent domain covers its subdomains, so "example.com" also covers "mail.example.com".
export async function isSpamExempt(mailboxId: string, fromAddress: string) {
  if (!fromAddress.includes("@")) return false;
  const domain = domainOf(fromAddress);
  if (!domain.includes(".")) return false;
  const parts = domain.split(".");
  const candidates = parts.slice(0, -1).map((_, index) => parts.slice(index).join("."));
  const db = getDb();
  const [row] = await db
    .select({ userId: spamExemptions.userId })
    .from(spamExemptions)
    .innerJoin(mailboxes, eq(mailboxes.id, mailboxId))
    .leftJoin(
      mailboxMembers,
      and(eq(mailboxMembers.mailboxId, mailboxes.id), eq(mailboxMembers.userId, spamExemptions.userId)),
    )
    .where(
      and(
        inArray(spamExemptions.domain, candidates),
        or(
          eq(mailboxes.personalUserId, spamExemptions.userId),
          and(isNull(mailboxes.personalUserId), eq(mailboxMembers.userId, spamExemptions.userId)),
        ),
      ),
    )
    .limit(1);
  return Boolean(row);
}
