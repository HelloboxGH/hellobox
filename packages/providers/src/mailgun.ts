import { createHmac, timingSafeEqual } from "node:crypto";
import { readObject } from "@hellobox/storage";
import { dmarcRecord, hasDmarcPolicy } from "./dns";
import { buildRawEmail, parseRawEmail } from "./mime";
import { StoredInbound } from "./pushed";
import type { DnsRecord, InboundEmail, InboundHint, MailProvider, OutgoingMessage, ProviderDomain } from "./types";

export type MailgunRegion = "us" | "eu";

export const MAILGUN_API: Record<MailgunRegion, string> = {
  us: "https://api.mailgun.net",
  eu: "https://api.eu.mailgun.net",
};

// Notifications older than this are refused, so a captured one can't be replayed later.
export const MAILGUN_MAX_AGE_SECONDS = 15 * 60;

export class MailgunError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MailgunError";
  }
}

// The key was revoked, or never worked. The connection needs reconnecting.
export const isMailgunAuthError = (error: unknown) => error instanceof MailgunError && error.status === 401;

type Fetch = typeof fetch;

// Our API key only ever goes to Mailgun. Stored messages live on its storage hosts, such
// as storage-us-east4.api.mailgun.net.
export function isMailgunUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "mailgun.net" || url.hostname.endsWith(".mailgun.net"));
  } catch {
    return false;
  }
}

// An inbound email's id is its storage URL, so the webhook and backfill name it the same
// way, and fetching it needs nothing else.
export const mailgunInboundId = (storageUrl: string) => Buffer.from(storageUrl).toString("base64url");
export const mailgunStorageUrl = (id: string) => Buffer.from(id, "base64url").toString("utf8");

export class MailgunApi {
  readonly base: string;

  constructor(
    private readonly apiKey: string,
    region: MailgunRegion,
    private readonly fetcher: Fetch = fetch,
  ) {
    this.base = MAILGUN_API[region];
  }

  // Forms for most endpoints; a plain object is sent as JSON.
  async call<T>(
    method: string,
    pathOrUrl: string,
    body?: FormData | URLSearchParams | Record<string, unknown>,
    accept = "application/json",
  ): Promise<T> {
    const url = pathOrUrl.startsWith("https://") ? pathOrUrl : `${this.base}${pathOrUrl}`;
    if (!isMailgunUrl(url)) throw new Error("Refusing to send the Mailgun key outside mailgun.net");
    const json = body !== undefined && !(body instanceof FormData) && !(body instanceof URLSearchParams);
    const res = await this.fetcher(url, {
      method,
      headers: {
        Accept: accept,
        Authorization: `Basic ${Buffer.from(`api:${this.apiKey}`).toString("base64")}`,
        ...(json ? { "Content-Type": "application/json" } : {}),
      },
      body: json ? JSON.stringify(body) : (body as FormData | URLSearchParams | undefined),
    });
    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      parsed = { message: text.slice(0, 200) };
    }
    if (!res.ok) {
      const message = typeof parsed.message === "string" ? parsed.message : `Mailgun answered ${res.status}`;
      throw new MailgunError(res.status === 401 ? "Mailgun didn't accept the API key" : message, res.status);
    }
    return parsed as T;
  }

  async listDomains() {
    const domains: MailgunDomain[] = [];
    for (let skip = 0; ; skip += 1000) {
      const page = await this.call<{ total_count: number; items: MailgunDomain[] }>("GET", `/v4/domains?limit=1000&skip=${skip}`);
      domains.push(...page.items);
      if (domains.length >= page.total_count || !page.items.length) return domains;
    }
  }
}

export interface MailgunDomain {
  name: string;
  state: string;
  type?: string;
}

interface MailgunDnsRecord {
  record_type: string;
  name?: string;
  value: string;
  priority?: string | number;
  valid?: string;
}

interface MailgunDomainDetails {
  domain: MailgunDomain;
  sending_dns_records: MailgunDnsRecord[];
  receiving_dns_records: MailgunDnsRecord[];
}

// Which region holds the account's domains. Regions are separate, so the key is tried
// in both. Null means it can't tell: domains in both, or in neither.
export async function detectMailgunRegion(apiKey: string, fetcher: Fetch = fetch): Promise<MailgunRegion | null> {
  const results = await Promise.allSettled(
    (["us", "eu"] as const).map(async (region) => ({ region, count: (await new MailgunApi(apiKey, region, fetcher).listDomains()).length })),
  );
  const found = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  // A key Mailgun refuses in every region is a wrong key, which is worth saying.
  if (!found.length) {
    const first = results[0];
    throw first?.status === "rejected" ? first.reason : new Error("Mailgun didn't answer");
  }
  const withDomains = found.filter((entry) => entry.count > 0);
  return withDomains.length === 1 ? withDomains[0]!.region : null;
}

// The logs query for messages stored for these domains over the last 3 days.
export function mailgunStoredQuery(domains: string[], now: Date, next?: string) {
  return {
    start: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toUTCString(),
    end: now.toUTCString(),
    events: ["stored"],
    filter: {
      AND: [{ attribute: "domain", comparator: "=", values: domains.map((domain) => ({ label: domain, value: domain })) }],
    },
    pagination: { sort: "timestamp:desc", limit: 100, ...(next ? { token: next } : {}) },
  };
}

// Webhooks

export interface MailgunSignature {
  timestamp: string;
  token: string;
  signature: string;
}

// HMAC-SHA256 of timestamp + token with the account's webhook signing key, and recent.
export function verifyMailgunSignature(input: Partial<MailgunSignature>, signingKey: string, now = Date.now()) {
  const { timestamp, token, signature } = input;
  if (!timestamp || !token || !signature || !/^[0-9a-f]+$/i.test(signature)) return false;
  const age = now / 1000 - Number(timestamp);
  if (!Number.isFinite(age) || Math.abs(age) > MAILGUN_MAX_AGE_SECONDS) return false;
  const expected = Buffer.from(createHmac("sha256", signingKey).update(timestamp + token).digest("hex"));
  const given = Buffer.from(signature.toLowerCase());
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// Routes are account-wide, so ours matches the domain's addresses and nothing else, in
// any letter case. Dots are escaped, so acme.com doesn't also match acmexcom.
export function mailgunRouteExpression(domain: string) {
  const pattern = [...domain.toLowerCase()]
    .map((char) => (char === "." ? "\\." : /[a-z]/.test(char) ? `[${char}${char.toUpperCase()}]` : char))
    .join("");
  return `match_recipient(".*@${pattern}$")`;
}

export const mailgunRouteAction = (notifyUrl: string) => `store(notify="${notifyUrl}")`;

export interface MailgunEventData {
  id?: string;
  event?: string;
  severity?: string;
  recipient?: string;
  reason?: string;
  message?: { headers?: { "message-id"?: string } };
  "delivery-status"?: { message?: string; description?: string; code?: number };
}

// Who a Mailgun event is about, and what the receiving server said.
export function mailgunEventDetail(event: MailgunEventData): { recipients: string[]; reason?: string } {
  const status = event["delivery-status"];
  const reason = event.event === "delivered" ? undefined : status?.message || status?.description || event.reason || undefined;
  const recipient = event.recipient?.trim().toLowerCase();
  return { recipients: recipient ? [recipient] : [], reason };
}

// Mailgun events, mapped onto the delivery statuses the inbox already shows.
export function mailgunDeliveryType(event: MailgunEventData) {
  switch (event.event) {
    case "delivered":
      return "email.delivered";
    case "complained":
      return "email.complained";
    case "permanent_fail":
      return "email.bounced";
    case "temporary_fail":
      return "email.delivery_delayed";
    case "failed":
      return event.severity === "permanent" ? "email.bounced" : "email.delivery_delayed";
    default:
      return null;
  }
}

const stripBrackets = (value: string) => value.trim().replace(/^<|>$/g, "");

// The provider

export interface MailgunTarget {
  workspaceId: string;
  connectionId: string;
  apiKey: string;
  region: MailgunRegion;
  // Receiving domain to the id of the route we made for it.
  routes: Record<string, string>;
}

const bareAddress = (value: string) => (value.match(/<([^>]+)>/)?.[1] ?? value).trim();
const domainOf = (address: string) => bareAddress(address).split("@")[1]?.toLowerCase() ?? "";

export class MailgunProvider implements MailProvider {
  readonly kind = "mailgun" as const;
  // Mailgun keeps stored mail for 3 days, which backfill reads, and domains verify in the
  // background after DNS changes.
  readonly capabilities = { backfill: true, refreshDomains: true };
  readonly api: MailgunApi;
  private readonly stored: StoredInbound;

  constructor(
    readonly target: MailgunTarget,
    fetcher: Fetch = fetch,
  ) {
    this.api = new MailgunApi(target.apiKey, target.region, fetcher);
    this.stored = new StoredInbound(target.workspaceId, target.connectionId);
  }

  // Sandbox domains only send to people you've authorised, so they're left out.
  async listDomains(): Promise<ProviderDomain[]> {
    const domains = await this.api.listDomains();
    return domains
      .filter((domain) => domain.type !== "sandbox")
      .map((domain) => {
        const name = domain.name.toLowerCase();
        const active = domain.state === "active";
        return {
          id: name,
          name,
          status: active ? "verified" : "pending",
          sending: active,
          receiving: name in this.target.routes,
        };
      });
  }

  // Our own MIME through messages.mime, so the threading headers are exactly ours.
  async send(message: OutgoingMessage) {
    const attachments = await Promise.all(
      (message.attachments ?? []).map(async (file) => ({
        filename: file.filename,
        contentType: file.contentType,
        contentId: file.contentId,
        content: new Uint8Array(await new Response(await readObject(file.storageKey)).arrayBuffer()),
      })),
    );
    const raw = await buildRawEmail(message, attachments);
    const form = new FormData();
    for (const recipient of [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])]) {
      form.append("to", bareAddress(recipient));
    }
    form.append("message", new Blob([new Uint8Array(raw)], { type: "message/rfc822" }), "message.eml");
    const domain = domainOf(message.from);
    const { id } = await this.api.call<{ id: string }>("POST", `/v3/${domain}/messages.mime`, form);
    // Events name the message by this id, without brackets.
    return { id: stripBrackets(id) };
  }

  // Our copy first. Without one, the copy Mailgun keeps for 3 days.
  async fetchInbound(id: string, hint?: InboundHint): Promise<InboundEmail> {
    const stored = await this.stored.read(id, hint);
    if (stored) return stored;
    return parseRawEmail(id, await this.fetchRaw(mailgunStorageUrl(id)), hint);
  }

  async fetchRaw(storageUrl: string) {
    const message = await this.api.call<{ "body-mime"?: string }>("GET", storageUrl, undefined, "message/rfc2822");
    if (!message["body-mime"]) throw new Error("Mailgun returned the message without its MIME");
    return new TextEncoder().encode(message["body-mime"]);
  }

  // Mail Mailgun stored for our routes in the last 3 days, newest first, from the logs.
  async listInbound(next?: string) {
    const domains = Object.keys(this.target.routes);
    if (!domains.length) return { ids: [] };
    const page = await this.api.call<{ items?: { storage?: { url?: string } }[]; pagination?: { next?: string } }>(
      "POST",
      "/v1/analytics/logs",
      mailgunStoredQuery(domains, new Date(), next),
    );
    const ids = (page.items ?? []).flatMap((item) =>
      item.storage?.url && isMailgunUrl(item.storage.url) ? [mailgunInboundId(item.storage.url)] : [],
    );
    return { ids, next: ids.length ? page.pagination?.next : undefined };
  }

  async afterIngest(id: string) {
    await this.stored.remove(id);
  }

  // Domains

  async addDomain(name: string) {
    try {
      await this.api.call("POST", "/v4/domains", new URLSearchParams({ name }));
    } catch (error) {
      // Mailgun answers 400 when the domain is already in the account.
      if (!(error instanceof MailgunError && error.status === 400 && /already/i.test(error.message))) throw error;
    }
    return this.domainRecords(name);
  }

  async domainRecords(name: string): Promise<DnsRecord[]> {
    const details = await this.api.call<MailgunDomainDetails>("GET", `/v4/domains/${encodeURIComponent(name)}`);
    // Asking Mailgun to check again saves people a trip to its dashboard.
    if (details.domain.state !== "active") {
      await this.api.call("PUT", `/v4/domains/${encodeURIComponent(name)}/verify`).catch(() => undefined);
    }
    return mailgunDomainRecords(name, details, {
      receiving: name in this.target.routes,
      needsDmarc: !(await hasDmarcPolicy(name)),
    });
  }

  // Receiving

  async createRoute(domain: string, notifyUrl: string) {
    const body = new URLSearchParams({
      priority: "0",
      description: `HelloBox: ${domain}`,
      expression: mailgunRouteExpression(domain),
      action: mailgunRouteAction(notifyUrl),
    });
    const { route } = await this.api.call<{ route: { id: string } }>("POST", "/v3/routes", body);
    return route.id;
  }

  async deleteRoute(id: string) {
    try {
      await this.api.call("DELETE", `/v3/routes/${id}`);
    } catch (error) {
      if (!(error instanceof MailgunError && error.status === 404)) throw error;
    }
  }

  // Delivery, failure and complaint events for the whole account (in this region).
  async createEventsWebhook(url: string) {
    const form = new FormData();
    form.append("url", url);
    form.append("description", "HelloBox delivery events");
    for (const type of ["delivered", "permanent_fail", "temporary_fail", "complained"]) form.append("event_types", type);
    const { webhook_id } = await this.api.call<{ webhook_id: string }>("POST", "/v1/webhooks", form);
    return webhook_id;
  }

  async deleteEventsWebhook(id: string) {
    try {
      await this.api.call("DELETE", `/v1/webhooks/${id}`);
    } catch (error) {
      if (!(error instanceof MailgunError && error.status === 404)) throw error;
    }
  }

  async disconnect(eventsWebhookId: string | null) {
    for (const id of Object.values(this.target.routes)) await this.deleteRoute(id);
    if (eventsWebhookId) await this.deleteEventsWebhook(eventsWebhookId);
  }
}

const recordPurpose = (record: MailgunDnsRecord) => {
  const value = record.value.toLowerCase();
  if (record.record_type === "TXT" && value.startsWith("v=spf1")) return "Lets Mailgun send for your domain (SPF)";
  if (record.record_type === "TXT") return "Signs your mail with DKIM and verifies the domain";
  if (record.record_type === "CNAME") return "Tracks opens and clicks. Optional";
  return "Needed by Mailgun";
};

// Mailgun's sending records, DMARC, and the MX records when the domain receives.
export function mailgunDomainRecords(
  name: string,
  details: Pick<MailgunDomainDetails, "sending_dns_records" | "receiving_dns_records">,
  options: { receiving: boolean; needsDmarc: boolean },
): DnsRecord[] {
  const records: DnsRecord[] = [];
  for (const record of details.sending_dns_records) {
    if (record.record_type !== "TXT" && record.record_type !== "CNAME") continue;
    const spf = record.record_type === "TXT" && record.value.toLowerCase().startsWith("v=spf1");
    records.push({
      type: record.record_type,
      name: (record.name || name).toLowerCase(),
      value: record.value,
      purpose: recordPurpose(record),
      // A domain has one SPF record. One that's already there needs Mailgun merged in.
      ...(spf ? { keepExisting: true } : {}),
    });
  }
  if (options.needsDmarc) records.push(dmarcRecord(name));
  if (options.receiving) {
    for (const record of details.receiving_dns_records) {
      if (record.record_type !== "MX") continue;
      records.push({
        type: "MX",
        name,
        value: record.value,
        priority: Number(record.priority ?? 10),
        purpose: "Delivers mail for this domain to Mailgun",
        keepExisting: true,
      });
    }
  }
  return records;
}
