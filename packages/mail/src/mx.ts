import { resolveMx } from "node:dns/promises";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { setting } from "@hellobox/config";
import { connections, domains, getDb, mailboxes, senderLists, workspaces } from "@hellobox/db";
import type { Authentication } from "@hellobox/providers";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { authenticate } from "mailauth";
import { domainKey, receivingDomainIds } from "./domains";
import { receivePushedEmail } from "./pushed";
import { hasTxtProof, txtRecordFor } from "./takeovers";
import { domainOf } from "./threading";

// HelloBox's own receiving. The mail server (apps/mx) accepts SMTP, asks whether each
// recipient's domain receives here, then posts the raw message. Everything it sends is
// signed with MX_SIGNING_KEY. It keeps no mail: it answers 250 only once we've stored it.

// Ids of mail received this way. Provider ids never start with it, so ingest knows to read
// the message from our storage whatever the connection's provider.
export const HELLOBOX_ID_PREFIX = "hb_";
export const isHelloboxReceived = (emailId: string) => emailId.startsWith(HELLOBOX_ID_PREFIX);

// The largest message the mail server accepts (its databytes), plus room for the headers it adds.
export const MX_MAX_BYTES = 26 * 1024 * 1024;
const MAX_SKEW_SECONDS = 300;

export const MX_HEADERS = {
  timestamp: "x-hellobox-timestamp",
  signature: "x-hellobox-signature",
  envelope: "x-hellobox-envelope",
} as const;

// What's signed: when, which call, the envelope as sent, and the body's hash. apps/mx
// builds the same string (plugins/hellobox.js).
export function mxSignature(key: string, timestamp: string, path: string, envelope: string, body: Uint8Array) {
  const digest = createHash("sha256").update(body).digest("hex");
  return createHmac("sha256", key).update(`${timestamp}\n${path}\n${envelope}\n${digest}`).digest("hex");
}

export type MxCheck = { ok: true } | { ok: false; status: 401 | 503 };

export function checkMxSignature(
  input: { timestamp: string | null; signature: string | null; path: string; envelope: string; body: Uint8Array },
  key = setting("MX_SIGNING_KEY"),
  now = Date.now(),
): MxCheck {
  // Not set up: receiving is off, and the mail server should try again later.
  if (!key) return { ok: false, status: 503 };
  const seconds = Number(input.timestamp);
  if (!input.timestamp || !Number.isInteger(seconds) || Math.abs(now / 1000 - seconds) > MAX_SKEW_SECONDS) {
    return { ok: false, status: 401 };
  }
  const expected = Buffer.from(mxSignature(key, input.timestamp, input.path, input.envelope, input.body));
  const given = Buffer.from(input.signature ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected) ? { ok: true } : { ok: false, status: 401 };
}

// Domain copies that take mail through HelloBox: switched on, still here, on a connection
// that isn't disconnected, and the one copy that receives (see receivesMail).
async function receivingCopies(name: string) {
  const rows = await getDb()
    .select({
      id: domains.id,
      workspaceId: domains.workspaceId,
      connectionId: domains.connectionId,
      name: domains.name,
      removedAt: domains.removedAt,
      bouncesEnabled: workspaces.bouncesEnabled,
    })
    .from(domains)
    .innerJoin(connections, eq(connections.id, domains.connectionId))
    .innerJoin(workspaces, eq(workspaces.id, domains.workspaceId))
    .where(
      and(
        sql`lower(rtrim(${domains.name}, '.')) = ${domainKey(name)}`,
        eq(domains.receiveWithHellobox, true),
        isNull(domains.removedAt),
        ne(connections.status, "disconnected"),
        ne(connections.provider, "demo"),
      ),
    );
  const receiving = await receivingDomainIds(rows);
  return rows.filter((row) => receiving.has(row.id));
}

const looksLikeAddress = (value: string) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value) && value.length <= 320;

// Whether the workspace has a mailbox for the address: on, not the hidden unknown-recipients one.
async function hasMailbox(workspaceId: string, address: string) {
  const [row] = await getDb()
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(
      and(
        eq(mailboxes.workspaceId, workspaceId),
        eq(mailboxes.address, address),
        eq(mailboxes.isCatchAll, false),
        isNull(mailboxes.removedAt),
      ),
    )
    .limit(1);
  return Boolean(row);
}

// Whether the workspace blocked this sender, by address or by domain. A null sender (a
// bounce) can't be blocked.
async function senderBlocked(workspaceId: string, mailFrom: string) {
  const address = mailFrom.trim().toLowerCase();
  if (!looksLikeAddress(address)) return false;
  const [row] = await getDb()
    .select({ id: senderLists.id })
    .from(senderLists)
    .where(
      and(
        eq(senderLists.workspaceId, workspaceId),
        eq(senderLists.kind, "blocked"),
        inArray(senderLists.value, [address, domainOf(address)]),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export interface MxDeps {
  senderBlocked: typeof senderBlocked;
  receivingCopies: typeof receivingCopies;
  hasMailbox: typeof hasMailbox;
  receive: typeof receivePushedEmail;
  authenticate: (raw: Uint8Array, envelope: MxEnvelope) => Promise<Authentication>;
}

// Whether to take mail for an address, and whether the answer holds for its whole domain
// (so the mail server may cache it per domain) or only for this address.
// - A domain that doesn't receive here: refused.
// - A workspace with bounces off takes any address: unknown ones land in Spam (see ingest).
// - With bounces on, an address with no mailbox is refused during the SMTP conversation
//   (550 5.1.1). The sender's own server tells them, so we never send anything to an address
//   that may be forged. It also tells anyone guessing which addresses exist, which is why
//   it's opt-in, and why the mail server limits refusals per IP.
export type MxRecipientDecision = { accept: boolean; scope: "domain" | "address" };

export async function mxRecipientDecision(
  address: string,
  deps: Pick<MxDeps, "receivingCopies" | "hasMailbox"> = defaultDeps,
): Promise<MxRecipientDecision> {
  const normalized = address.trim().toLowerCase();
  if (!looksLikeAddress(normalized)) return { accept: false, scope: "address" };
  const copies = await deps.receivingCopies(domainOf(normalized));
  if (!copies.length) return { accept: false, scope: "domain" };
  // Only one workspace ever receives a domain (see receivesMail).
  const { workspaceId, bouncesEnabled } = copies[0] as (typeof copies)[number];
  if (!bouncesEnabled) return { accept: true, scope: "domain" };
  return { accept: await deps.hasMailbox(workspaceId, normalized), scope: "address" };
}

// What the mail server saw in the SMTP conversation.
export interface MxEnvelope {
  recipients: string[];
  mailFrom: string;
  ip: string;
  helo: string;
}

export function parseMxEnvelope(value: string): MxEnvelope | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<MxEnvelope>;
    const recipients = Array.isArray(parsed.recipients)
      ? parsed.recipients.filter((item): item is string => typeof item === "string").map((item) => item.trim().toLowerCase())
      : [];
    if (!recipients.length || recipients.length > 100) return null;
    if (typeof parsed.ip !== "string" || !parsed.ip) return null;
    return {
      recipients: [...new Set(recipients)],
      mailFrom: typeof parsed.mailFrom === "string" ? parsed.mailFrom.slice(0, 320) : "",
      ip: parsed.ip,
      helo: typeof parsed.helo === "string" ? parsed.helo.slice(0, 255) : "",
    };
  } catch {
    return null;
  }
}

// SPF, DKIM and DMARC, checked here rather than trusted from the message: an
// Authentication-Results header in the mail is whatever the sender wrote. Every field is
// always set, so ingest never falls back to reading one.
async function authenticateMail(raw: Uint8Array, envelope: MxEnvelope): Promise<Authentication> {
  try {
    const result = await authenticate(Buffer.from(raw), {
      ip: envelope.ip,
      helo: envelope.helo,
      sender: envelope.mailFrom || undefined,
      mta: setting("MX_HOSTNAME") || "hellobox",
      disableArc: true,
      disableBimi: true,
    });
    const dkim = result.dkim.results.find((item) => item.status.result === "pass") ?? result.dkim.results[0];
    return {
      spf: result.spf ? result.spf.status.result : "none",
      dkim: dkim ? dkim.status.result : "none",
      dmarc: result.dmarc ? result.dmarc.status.result : "none",
    };
  } catch (error) {
    console.error("[mx] Couldn't check SPF, DKIM and DMARC:", error);
    return { spf: "temperror", dkim: "temperror", dmarc: "temperror" };
  }
}

const defaultDeps: MxDeps = { senderBlocked, receivingCopies, hasMailbox, receive: receivePushedEmail, authenticate: authenticateMail };

// The same message and recipients always get the same id, so a retry after a timeout
// doesn't make a second copy.
export function helloboxEmailId(raw: Uint8Array, recipients: string[]) {
  const hash = createHash("sha256").update(raw).update("\n").update([...recipients].sort().join(",")).digest("hex");
  return `${HELLOBOX_ID_PREFIX}${hash.slice(0, 48)}`;
}

// "blocked": every workspace that takes these recipients blocked the sender. The mail
// server refuses it with a 550, so the sender's own server bounces it to them. Nothing is
// stored and we send nothing ourselves.
export type MxDelivery = { status: "stored"; ids: string[] } | { status: "no-recipients" } | { status: "blocked" };

// Stores the message once per connection that takes one of its recipients, then queues
// ingest. Throws when anything fails, so the mail server answers 451 and the sender retries;
// ids already stored are simply found again.
export async function receiveFromMx(raw: Uint8Array, envelope: MxEnvelope, deps: MxDeps = defaultDeps): Promise<MxDelivery> {
  const groups = new Map<string, { workspaceId: string; recipients: string[] }>();
  const copiesByDomain = new Map<string, Awaited<ReturnType<typeof receivingCopies>>>();
  for (const recipient of envelope.recipients) {
    if (!looksLikeAddress(recipient)) continue;
    const domain = domainOf(recipient);
    if (!copiesByDomain.has(domain)) copiesByDomain.set(domain, await deps.receivingCopies(domain));
    for (const copy of copiesByDomain.get(domain) ?? []) {
      const group = groups.get(copy.connectionId) ?? { workspaceId: copy.workspaceId, recipients: [] };
      group.recipients.push(recipient);
      groups.set(copy.connectionId, group);
    }
  }
  if (!groups.size) return { status: "no-recipients" };
  for (const [connectionId, group] of groups) {
    if (await deps.senderBlocked(group.workspaceId, envelope.mailFrom)) groups.delete(connectionId);
  }
  if (!groups.size) return { status: "blocked" };

  const authentication = await deps.authenticate(raw, envelope);
  const ids: string[] = [];
  for (const [connectionId, group] of groups) {
    const emailId = helloboxEmailId(raw, group.recipients);
    await deps.receive({
      connectionId,
      workspaceId: group.workspaceId,
      emailId,
      providerEventId: `hellobox:${emailId}`,
      raw,
      hint: { recipients: group.recipients, authentication },
      payload: { via: "hellobox", ip: envelope.ip, mailFrom: envelope.mailFrom || null },
    });
    ids.push(emailId);
  }
  return { status: "stored", ids };
}

// Turning HelloBox receiving on for a domain. The mail server must know the domain before
// its MX moves, so DNS control is proven first with a TXT record, separate from the MX.

export class ReceivingError extends Error {}

// The mail server's name, or null when this HelloBox has none: then settings doesn't offer
// receiving with HelloBox at all.
export function helloboxMxHost() {
  if (!setting("MX_SIGNING_KEY")) return null;
  return setting("MX_HOSTNAME")?.trim().toLowerCase().replace(/\.$/, "") || null;
}

// The MX record a receiving domain points at the mail server. Its only one: any other MX
// record left in place gets some of the mail.
export const helloboxMxRecord = (domain: string, host: string) => ({ type: "MX" as const, name: domain, value: host, priority: 10 });

function mxHostOrThrow() {
  const host = helloboxMxHost();
  if (!host) throw new ReceivingError("Receiving with HelloBox isn't set up on this server");
  return host;
}

async function ownedDomain(workspaceId: string, domainId: string) {
  const [domain] = await getDb()
    .select()
    .from(domains)
    .where(and(eq(domains.id, domainId), eq(domains.workspaceId, workspaceId), isNull(domains.removedAt)));
  if (!domain) throw new ReceivingError("That domain isn't in this workspace");
  return domain;
}

// The TXT record to add. The token stays the same until receiving is turned off.
export async function startHelloboxReceiving(workspaceId: string, domainId: string) {
  const host = mxHostOrThrow();
  const domain = await ownedDomain(workspaceId, domainId);
  const token = domain.receiveToken ?? randomBytes(18).toString("base64url");
  if (!domain.receiveToken) {
    await getDb().update(domains).set({ receiveToken: token }).where(eq(domains.id, domain.id));
  }
  return { record: txtRecordFor(domain.name, token), mx: helloboxMxRecord(domain.name, host), on: domain.receiveWithHellobox, replacedMx: domain.replacedMx ?? [] };
}

// Checks the TXT record and turns receiving on. False while the record isn't visible yet.
export async function confirmHelloboxReceiving(workspaceId: string, domainId: string, proof = hasTxtProof) {
  mxHostOrThrow();
  const domain = await ownedDomain(workspaceId, domainId);
  if (domain.receiveWithHellobox) return true;
  if (!domain.receiveToken) throw new ReceivingError("Start receiving with HelloBox first");
  if (!(await proof(domain.name, domain.receiveToken))) return false;
  await getDb().update(domains).set({ receiveWithHellobox: true }).where(eq(domains.id, domain.id));
  return true;
}

// Back to the provider. A new token is needed to turn it on again.
export async function stopHelloboxReceiving(workspaceId: string, domainId: string) {
  const domain = await ownedDomain(workspaceId, domainId);
  await getDb().update(domains).set({ receiveWithHellobox: false, receiveToken: null }).where(eq(domains.id, domain.id));
}

export type MxLookup = (domain: string) => Promise<{ exchange: string; priority: number }[]>;

const lookupMx: MxLookup = async (domain) => {
  try {
    return await resolveMx(domain);
  } catch {
    return [];
  }
};

// Whether the domain's MX records, as DNS answers right now, point at the mail server and
// nowhere else. Any other record left in place gets part of the mail.
export async function checkHelloboxMx(workspaceId: string, domainId: string, lookup: MxLookup = lookupMx) {
  const host = mxHostOrThrow();
  const domain = await ownedDomain(workspaceId, domainId);
  const found = (await lookup(domain.name)).map((record) => ({
    value: record.exchange.toLowerCase().replace(/\.$/, ""),
    priority: record.priority,
  }));
  return { pointsHere: mxPointsHere(found, host), found };
}

export const mxPointsHere = (found: { value: string }[], host: string) =>
  found.length > 0 && found.every((record) => record.value === host);
