import { createHmac, timingSafeEqual } from "node:crypto";
import { readObject } from "@hellobox/storage";
import { hasDmarcPolicy } from "./dns";
import { parseRawEmail } from "./mime";
import type { DnsRecord, InboundEmail, InboundHint, InboundPage, MailProvider, OutgoingMessage, ProviderDomain, SentMessage } from "./types";

// Bird (bird.com, which took over SparkPost), through its platform email API with a
// workspace access key. Regions are separate hosts, and a key only works on its own.
export type BirdRegion = "us1" | "eu1";

export const birdApi = (region: BirdRegion) => `https://${region}.platform.bird.com`;

export class BirdError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "BirdError";
  }
}

export const isBirdAuthError = (error: unknown) => error instanceof BirdError && error.status === 401;

// Keys name their region: bk_us1_…, bm_eu1_…
export function birdRegionOf(key: string): BirdRegion | null {
  const region = key.match(/^b[km]_(us1|eu1)_/)?.[1];
  return region === "us1" || region === "eu1" ? region : null;
}

type Fetch = typeof fetch;

export class BirdApi {
  constructor(
    readonly apiKey: string,
    readonly region: BirdRegion,
    private readonly fetcher: Fetch = fetch,
  ) {}

  async response(method: string, path: string, body?: unknown) {
    const res = await this.fetcher(`${birdApi(this.region)}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      let json: { error?: { code?: string; message?: string } } | null = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      throw new BirdError(birdMessage(json?.error, res.status), res.status, json?.error?.code);
    }
    return res;
  }

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const text = await (await this.response(method, path, body)).text();
    return (text ? JSON.parse(text) : null) as T;
  }
}

// Bird answers { error: { type, code, message, … } }.
function birdMessage(error: { message?: string } | undefined, status: number) {
  if (status === 401) return "Bird didn't accept the access key";
  if (status === 403 && !error?.message) return "The access key is missing a permission HelloBox needs. Use a key with email and webhook access.";
  return error?.message ?? `Bird answered ${status}`;
}

// The region whose host accepts the key: read from the key, else tried in turn.
export async function detectBirdRegion(apiKey: string, fetcher: Fetch = fetch): Promise<BirdRegion | null> {
  const named = birdRegionOf(apiKey);
  for (const region of named ? [named] : (["us1", "eu1"] as const)) {
    try {
      await new BirdApi(apiKey, region, fetcher).call("GET", "/v1/email/domains?limit=1");
      return region;
    } catch (error) {
      // 421: the key belongs to the other region.
      if (!(error instanceof BirdError && (error.status === 401 || error.status === 421))) throw error;
    }
  }
  return null;
}

// Domains

interface BirdDnsRecord {
  type: "TXT" | "CNAME" | "MX";
  name: string;
  host: string;
  value: string;
  purpose: "dkim" | "return_path" | "tracking" | "inbound_mx" | "dmarc";
  optional: boolean;
  state?: string;
}

export interface BirdDomain {
  id: string;
  domain: string;
  status: string;
  capabilities?: { sending?: { status?: string } };
  receiving?: { state?: string; managed_elsewhere?: boolean };
  dns_records?: BirdDnsRecord[];
}

const PURPOSES: Record<string, string> = {
  dkim: "Signs your mail with DKIM",
  return_path: "Handles bounces, and covers SPF, for your domain",
  dmarc: "Tells receiving servers what to do with mail that fails checks (DMARC)",
  inbound_mx: "Delivers mail for this domain to Bird, which passes it to HelloBox",
};

// The records Bird needs to send (DKIM, return path, DMARC unless the domain has a
// policy), and its MX records when the domain receives. Link tracking's is left out:
// HelloBox turns tracking off.
export function birdDomainRecords(domain: BirdDomain, options: { receiving: boolean; needsDmarc: boolean }): DnsRecord[] {
  const records: DnsRecord[] = [];
  for (const record of domain.dns_records ?? []) {
    if (record.state === "deprecated" || record.purpose === "tracking") continue;
    if (record.purpose === "dmarc" && !options.needsDmarc) continue;
    if (record.purpose === "inbound_mx" && !options.receiving) continue;
    const name = record.host.toLowerCase().replace(/\.$/, "");
    if (record.type === "MX") {
      // "10 inbound.example.net"
      const [priority, host] = record.value.trim().split(/\s+/);
      records.push({
        type: "MX",
        name,
        value: (host ?? priority ?? "").replace(/\.$/, ""),
        priority: host ? Number(priority) : 10,
        purpose: PURPOSES.inbound_mx!,
        keepExisting: true,
      });
      continue;
    }
    records.push({
      type: record.type,
      name,
      value: record.value,
      purpose: PURPOSES[record.purpose] ?? "Needed by Bird",
      ...(record.purpose === "dmarc" ? { keepExisting: true } : {}),
    });
  }
  return records;
}

// Sending

// Bird takes addresses as written ("Ada <ada@example.com>"), threading headers in
// `headers`, and is told this is transactional mail with no tracking, so it adds neither
// an unsubscribe footer nor rewritten links.
export function birdMailBody(
  message: OutgoingMessage,
  attachments: { filename: string; contentType: string; contentId?: string; content: Uint8Array }[],
  options: { messageId: boolean } = { messageId: true },
) {
  const headers = Object.fromEntries(Object.entries(message.headers ?? {}).filter(([name]) => options.messageId || name !== "Message-ID"));
  const tags = Object.entries(message.tags ?? {}).slice(0, 20).map(([name, value]) => ({ name, value }));
  return {
    from: message.from,
    to: message.to,
    ...(message.cc?.length ? { cc: message.cc } : {}),
    ...(message.bcc?.length ? { bcc: message.bcc } : {}),
    ...(message.replyTo?.length ? { reply_to: message.replyTo } : {}),
    subject: message.subject,
    ...(message.html ? { html: message.html } : {}),
    ...(message.text || !message.html ? { text: message.text || " " } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(tags.length ? { tags } : {}),
    category: "transactional",
    track_opens: false,
    track_clicks: false,
    ...(attachments.length
      ? {
          attachments: attachments.map((file) => ({
            filename: file.filename,
            content: Buffer.from(file.content).toString("base64"),
            content_type: file.contentType,
            ...(file.contentId ? { content_id: file.contentId } : {}),
          })),
        }
      : {}),
  };
}

// Events

export interface BirdEvent {
  type?: string;
  timestamp?: string;
  data?: {
    email_id?: string;
    recipient?: string;
    bounce_type?: string;
    bounce_description?: string | null;
    defer_reason?: string | null;
    rejection_reason?: string | null;
    inbound_message_id?: string;
    to?: (string | { email?: string })[];
    spf_pass?: boolean | null;
    dkim_pass?: boolean | null;
  };
}

// The events HelloBox listens to, received mail included.
export const BIRD_EVENTS = [
  "email.delivered",
  "email.deferred",
  "email.bounced",
  "email.out_of_band_bounce",
  "email.complained",
  "email.rejected",
  "email.received",
];

// Bird events, mapped onto the delivery statuses the inbox already shows. Only a hard
// bounce says the address is bad; a block or an admin bounce is about the message.
export function birdDeliveryType(event: BirdEvent) {
  switch (event.type) {
    case "email.delivered":
      return "email.delivered";
    case "email.deferred":
      return "email.delivery_delayed";
    case "email.bounced":
    case "email.out_of_band_bounce":
      return event.data?.bounce_type === "hard" ? "email.bounced" : "email.failed";
    case "email.complained":
      return "email.complained";
    case "email.rejected":
      return "email.failed";
    default:
      return null;
  }
}

export function birdEventDetail(event: BirdEvent): { recipients: string[]; reason?: string } {
  const recipient = event.data?.recipient?.trim().toLowerCase();
  const reason = event.data?.bounce_description || event.data?.defer_reason || event.data?.rejection_reason || undefined;
  return { recipients: recipient ? [recipient] : [], reason: event.type === "email.delivered" ? undefined : reason };
}

export function birdInboundHint(event: BirdEvent): InboundHint {
  const recipients = (event.data?.to ?? [])
    .map((entry) => (typeof entry === "string" ? (entry.match(/<([^>]+)>/)?.[1] ?? entry) : entry.email))
    .filter((value): value is string => Boolean(value))
    .map((value) => value.trim().toLowerCase());
  const verdict = (pass: boolean | null | undefined) => (pass === true ? "pass" : pass === false ? "fail" : undefined);
  const spf = verdict(event.data?.spf_pass);
  const dkim = verdict(event.data?.dkim_pass);
  return { recipients, ...(spf || dkim ? { authentication: { ...(spf ? { spf } : {}), ...(dkim ? { dkim } : {}) } } : {}) };
}

// Standard Webhooks: HMAC-SHA256 of "id.timestamp.body" with the secret after "whsec_",
// base64, as "v1,<signature>" (several, space-separated, while a secret rotates).
export function verifyBirdSignature(
  secret: string,
  input: { id: string | null; timestamp: string | null; signature: string | null; body: Uint8Array },
  now = Date.now(),
  maxAgeSeconds = 300,
) {
  if (!input.id || !input.timestamp || !input.signature) return false;
  const seconds = Number(input.timestamp);
  if (!Number.isFinite(seconds) || Math.abs(now / 1000 - seconds) > maxAgeSeconds) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key)
    .update(`${input.id}.${input.timestamp}.`)
    .update(input.body)
    .digest();
  return input.signature.split(" ").some((entry) => {
    const [version, value] = entry.split(",");
    if (version !== "v1" || !value) return false;
    const given = Buffer.from(value, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

// The provider

export interface BirdTarget {
  apiKey: string;
  region: BirdRegion;
  // Domains HelloBox turned receiving on for, turned off again on disconnect.
  receiving: string[];
  // Domains waiting for Bird to allow receiving (it needs DKIM verified first). Their MX
  // records are shown already.
  pending?: string[];
}

interface InboundSummary {
  id: string;
  to?: { email?: string }[];
  cc?: { email?: string }[];
}

export class BirdProvider implements MailProvider {
  readonly kind = "bird" as const;
  // Bird keeps received mail for 30 days, which backfill reads.
  readonly capabilities = { receiving: true, backfill: true, refreshDomains: true };
  readonly api: BirdApi;

  constructor(
    readonly target: BirdTarget,
    fetcher: Fetch = fetch,
  ) {
    this.api = new BirdApi(target.apiKey, target.region, fetcher);
  }

  async allDomains(): Promise<BirdDomain[]> {
    const domains: BirdDomain[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 50; page += 1) {
      const query: string = cursor ? `&starting_after=${encodeURIComponent(cursor)}` : "";
      const result: { data?: BirdDomain[]; next_cursor?: string | null } = await this.api.call("GET", `/v1/email/domains?limit=100${query}`);
      domains.push(...(result.data ?? []));
      cursor = result.next_cursor ?? null;
      if (!cursor) break;
    }
    return domains;
  }

  async listDomains(): Promise<ProviderDomain[]> {
    return (await this.allDomains()).map((domain) => {
      const sending = domain.capabilities?.sending?.status === "verified";
      return {
        id: domain.id,
        name: domain.domain.toLowerCase(),
        status: domain.status === "verified" || sending ? "verified" : domain.status === "failed" || domain.status === "rejected" ? "failed" : "pending",
        sending,
        receiving: domain.receiving?.state === "enabled",
      };
    });
  }

  async send(message: OutgoingMessage): Promise<SentMessage> {
    const attachments = await Promise.all(
      (message.attachments ?? []).map(async (file) => ({
        filename: file.filename,
        contentType: file.contentType,
        contentId: file.contentId,
        content: new Uint8Array(await new Response(await readObject(file.storageKey)).arrayBuffer()),
      })),
    );
    let sent: { id: string };
    try {
      sent = await this.api.call("POST", "/v1/email/messages", birdMailBody(message, attachments));
    } catch (error) {
      // Should Bird keep Message-ID for itself, the email still goes out, threaded by
      // In-Reply-To and References.
      if (!(message.headers?.["Message-ID"] && error instanceof BirdError && error.status === 422 && /message-id|header/i.test(error.message))) throw error;
      sent = await this.api.call("POST", "/v1/email/messages", birdMailBody(message, attachments, { messageId: false }));
    }
    // Events name the message by this id.
    return { id: sent.id };
  }

  // Bird keeps the original message for us.
  async fetchInbound(id: string, hint?: InboundHint): Promise<InboundEmail> {
    const res = await this.api.response("GET", `/v1/email/inbound-messages/${encodeURIComponent(id)}/raw`);
    return parseRawEmail(id, new Uint8Array(await res.arrayBuffer()), hint);
  }

  // Received mail for this workspace's receiving domains, newest first. Other mail Bird
  // received (its own inbound addresses, mailboxes) is left alone.
  async listInbound(next?: string): Promise<InboundPage> {
    const receiving = new Set((await this.allDomains()).filter((domain) => domain.receiving?.state === "enabled").map((domain) => domain.domain.toLowerCase()));
    const query = next ? `&starting_after=${encodeURIComponent(next)}` : "";
    const page = await this.api.call<{ data?: InboundSummary[]; next_cursor?: string | null }>("GET", `/v1/email/inbound-messages?limit=100${query}`);
    const ours = (page.data ?? []).filter((message) =>
      [...(message.to ?? []), ...(message.cc ?? [])].some((address) => receiving.has(address.email?.split("@")[1]?.toLowerCase() ?? "")),
    );
    return { ids: ours.map((message) => message.id), ...(page.next_cursor ? { next: page.next_cursor } : {}) };
  }

  // Domains

  async findDomain(name: string) {
    const domain = (await this.allDomains()).find((item) => item.domain.toLowerCase() === name);
    if (!domain) throw new Error(`${name} isn't in this Bird workspace`);
    return domain;
  }

  async addDomain(name: string) {
    try {
      await this.api.call("POST", "/v1/email/domains", { domain: name });
    } catch (error) {
      // Already in the workspace.
      if (!(error instanceof BirdError && error.status === 409)) throw error;
    }
    return this.domainRecords(name);
  }

  async domainRecords(name: string): Promise<DnsRecord[]> {
    let domain = await this.findDomain(name);
    // Asking Bird to check again saves people a trip to its dashboard.
    if (domain.capabilities?.sending?.status !== "verified") {
      domain = (await this.api.call<BirdDomain | null>("POST", `/v1/email/domains/${domain.id}/verify`).catch(() => null)) ?? domain;
      if (!domain.dns_records) domain = await this.findDomain(name);
    }
    const receiving = domain.receiving?.state === "enabled" || Boolean(this.target.pending?.includes(name));
    return birdDomainRecords(domain, { receiving, needsDmarc: !(await hasDmarcPolicy(name)) });
  }

  // Receiving is a switch on the domain; Bird posts email.received to our webhook.
  async setReceiving(name: string, on: boolean) {
    const domain = await this.findDomain(name);
    return this.api.call<BirdDomain>("PATCH", `/v1/email/domains/${domain.id}`, { inbound: { enabled: on } });
  }

  // One webhook for delivery events and received mail.
  async createWebhook(url: string) {
    const created = await this.api.call<{ id: string; secret: string }>("POST", "/v1/webhooks", {
      url,
      events: BIRD_EVENTS,
      description: "HelloBox: delivery events and received mail",
    });
    return { id: created.id, secret: created.secret };
  }

  async deleteWebhook(id: string) {
    try {
      await this.api.call("DELETE", `/v1/webhooks/${encodeURIComponent(id)}`);
    } catch (error) {
      if (!(error instanceof BirdError && error.status === 404)) throw error;
    }
  }

  // Receiving is turned off only where HelloBox turned it on.
  async disconnect(webhookId: string | null) {
    for (const name of this.target.receiving) {
      await this.setReceiving(name, false).catch((error: unknown) => {
        if (!(error instanceof BirdError && error.status === 404) && !(error instanceof Error && /isn't in this Bird workspace/.test(error.message))) throw error;
      });
    }
    if (webhookId) await this.deleteWebhook(webhookId);
  }
}
