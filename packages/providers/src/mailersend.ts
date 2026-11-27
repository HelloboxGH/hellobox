import { createHmac, timingSafeEqual } from "node:crypto";
import { readObject } from "@hellobox/storage";
import MailComposer from "nodemailer/lib/mail-composer";
import { dmarcRecord, hasDmarcPolicy } from "./dns";
import { StoredInbound } from "./pushed";
import type { DnsRecord, InboundEmail, InboundHint, MailProvider, OutgoingMessage, ProviderDomain, SentMessage } from "./types";

// MailerSend, through its v1 API with the customer's API token. One host for every account.
export const MAILERSEND_API = "https://api.mailersend.com";

// Where inbound routing receives mail, unless MailerSend says otherwise for a route.
export const MAILERSEND_INBOUND_MX = "inbound.mailersend.net";

export class MailersendError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MailersendError";
  }
}

export const isMailersendAuthError = (error: unknown) => error instanceof MailersendError && error.status === 401;

type Fetch = typeof fetch;

export class MailersendApi {
  constructor(
    readonly apiKey: string,
    private readonly fetcher: Fetch = fetch,
  ) {}

  async request(method: string, path: string, body?: unknown): Promise<{ json: unknown; headers: Headers }> {
    const res = await this.fetcher(`${MAILERSEND_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) throw new MailersendError(mailersendMessage(json, res.status), res.status);
    return { json, headers: res.headers };
  }

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await this.request(method, path, body)).json as T;
  }
}

// MailerSend answers { message, errors: { field: [...] } }, with a code like "#MS42207"
// at the end of the message.
function mailersendMessage(json: unknown, status: number) {
  const body = json as { message?: string; errors?: Record<string, string[]> } | null;
  if (status === 401) return "MailerSend didn't accept the API token";
  if (status === 403 && !body?.message) return "The API token doesn't have the permissions HelloBox needs. Use a token with full access to all domains.";
  const details = Object.values(body?.errors ?? {}).flat().filter(Boolean);
  const message = details.length ? details.join(" ") : body?.message;
  return message ? message.replace(/\s*#MS\d+\s*$/, "") : `MailerSend answered ${status}`;
}

// Domains

interface MailersendDnsRecord {
  hostname?: string | null;
  type?: string | null;
  value?: string | null;
  priority?: string | number | null;
}

export interface MailersendDomain {
  id: string;
  name: string;
  is_verified: boolean;
}

const PURPOSES: Record<string, string> = {
  spf: "Lets MailerSend send for your domain (SPF)",
  dkim_ms1: "Signs your mail with DKIM",
  dkim_ms2: "Signs your mail with DKIM (second key, for rotation)",
  dkim: "Signs your mail with DKIM",
  return_path: "Handles bounces for your domain",
};

// MailerSend's records (not its tracking or inbound-subdomain ones: HelloBox tracks
// nothing and receives on the domain itself), DMARC, and the MX when the domain receives.
export function mailersendDomainRecords(
  domain: string,
  dns: Record<string, MailersendDnsRecord | string | undefined>,
  options: { receiving: string | null; needsDmarc: boolean },
): DnsRecord[] {
  const records: DnsRecord[] = [];
  for (const [key, record] of Object.entries(dns)) {
    if (!PURPOSES[key] || !record || typeof record === "string") continue;
    const type = record.type?.toUpperCase();
    if (!record.hostname || !record.value || (type !== "CNAME" && type !== "TXT")) continue;
    const spf = key === "spf";
    records.push({
      type,
      name: record.hostname.toLowerCase().replace(/\.$/, ""),
      value: record.value,
      purpose: PURPOSES[key]!,
      // A domain has one SPF record. One that's already there needs MailerSend merged in.
      ...(spf ? { keepExisting: true } : {}),
    });
  }
  if (options.needsDmarc) records.push(dmarcRecord(domain));
  if (options.receiving) {
    records.push({
      type: "MX",
      name: domain,
      value: options.receiving,
      priority: 10,
      purpose: "Delivers mail for this domain to MailerSend, which passes it to HelloBox",
      keepExisting: true,
    });
  }
  return records;
}

// Sending

export function mailersendAddress(value: string): { email: string; name?: string } {
  const match = value.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (!match) return { email: value.trim() };
  const name = match[1]?.replace(/^"|"$/g, "").replace(/[<>]/g, "").trim();
  return { email: match[2]!.trim(), ...(name ? { name } : {}) };
}

const referenceList = (value: string | undefined) => value?.match(/<[^>]+>/g) ?? (value?.trim() ? [value.trim()] : []);

// The JSON for /v1/email. MailerSend writes its own Message-ID (custom headers need a
// paid plan), so threading goes in its in_reply_to and references fields. Tags become
// MailerSend tags, which allow five.
export function mailersendMailBody(
  message: OutgoingMessage,
  attachments: { filename: string; contentId?: string; content: Uint8Array }[],
  options: { threading: boolean } = { threading: true },
) {
  const list = (values: string[] | undefined) => (values?.length ? values.map(mailersendAddress) : undefined);
  const inReplyTo = options.threading ? message.headers?.["In-Reply-To"]?.trim() : undefined;
  const references = options.threading ? referenceList(message.headers?.References) : [];
  const tags = Object.entries(message.tags ?? {})
    .slice(0, 5)
    .map(([key, value]) => `${key}:${value}`.slice(0, 191));
  return {
    from: mailersendAddress(message.from),
    to: list(message.to),
    cc: list(message.cc),
    bcc: list(message.bcc),
    ...(message.replyTo?.[0] ? { reply_to: mailersendAddress(message.replyTo[0]) } : {}),
    subject: message.subject,
    ...(message.html ? { html: message.html } : {}),
    ...(message.text || !message.html ? { text: message.text || " " } : {}),
    ...(inReplyTo ? { in_reply_to: inReplyTo } : {}),
    ...(references.length ? { references } : {}),
    ...(tags.length ? { tags } : {}),
    ...(attachments.length
      ? {
          attachments: attachments.map((file) => ({
            content: Buffer.from(file.content).toString("base64"),
            filename: file.filename,
            disposition: file.contentId ? "inline" : "attachment",
            ...(file.contentId ? { id: file.contentId } : {}),
          })),
        }
      : {}),
  };
}

// Events

export interface MailersendEvent {
  type?: string;
  created_at?: string;
  data?: {
    id?: string;
    domain_id?: string;
    message_id?: string;
    email_id?: string;
    type?: string;
    recipient?: string;
    meta?: { bounce_reason?: string; suppression_reason?: string } | unknown[];
  };
}

const EVENTS = ["activity.delivered", "activity.soft_bounced", "activity.hard_bounced", "activity.spam_complaint"];

// MailerSend events, mapped onto the delivery statuses the inbox already shows. A soft
// bounce is retried, so it's a delay.
export function mailersendDeliveryType(event: MailersendEvent) {
  switch (event.type) {
    case "activity.delivered":
      return "email.delivered";
    case "activity.hard_bounced":
      return "email.bounced";
    case "activity.soft_bounced":
    case "activity.deferred":
      return "email.delivery_delayed";
    case "activity.spam_complaint":
      return "email.complained";
    case "activity.suppressed":
      return "email.failed";
    default:
      return null;
  }
}

export function mailersendEventDetail(event: MailersendEvent): { recipients: string[]; reason?: string } {
  const recipient = event.data?.recipient?.trim().toLowerCase();
  const meta = Array.isArray(event.data?.meta) ? undefined : event.data?.meta;
  return { recipients: recipient ? [recipient] : [], reason: meta?.bounce_reason || meta?.suppression_reason || undefined };
}

// HMAC-SHA256 of the raw body with the webhook's secret, in hex.
export function verifyMailersendSignature(secret: string, signature: string | null, body: Uint8Array) {
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  const given = /^[0-9a-f]+$/i.test(signature.trim()) ? Buffer.from(signature.trim(), "hex") : Buffer.from(signature.trim(), "base64");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// Inbound routing

export interface MailersendInboundData {
  id?: string;
  raw?: string;
  from?: { raw?: string; name?: string; email?: string };
  recipients?: {
    to?: { raw?: string; data?: { name?: string; email?: string }[] };
    cc?: { raw?: string; data?: { name?: string; email?: string }[] };
    rcptTo?: { email?: string }[];
  };
  subject?: string;
  date?: string;
  headers?: Record<string, string | string[]>;
  text?: string | null;
  html?: string | null;
  attachments?: { filename?: string; content_type?: string; content?: string; content_id?: string }[];
  spf_check?: { code?: string };
}

const looksLikeMime = (text: string) => /^[\x21-\x39\x3b-\x7e]+:/m.test(text.slice(0, 2000)) && /\r?\n\r?\n/.test(text);

const COMPOSED_HEADERS = new Set([
  "from", "to", "cc", "bcc", "reply-to", "subject", "date", "message-id", "mime-version",
  "content-type", "content-transfer-encoding",
]);

// The raw message: MailerSend's copy when it sends one (as text or base64), else rebuilt
// from the parsed fields and original headers.
export async function mailersendInboundRaw(data: MailersendInboundData): Promise<Uint8Array> {
  if (data.raw) {
    if (looksLikeMime(data.raw)) return new TextEncoder().encode(data.raw);
    const decoded = Buffer.from(data.raw, "base64").toString("utf8");
    if (looksLikeMime(decoded)) return new TextEncoder().encode(decoded);
  }
  const headers = Object.entries(data.headers ?? {});
  const header = (name: string) => {
    const value = headers.find(([key]) => key.toLowerCase() === name)?.[1];
    return Array.isArray(value) ? value[0] : value;
  };
  const date = data.date ? new Date(data.date) : undefined;
  const composer = new MailComposer({
    from: data.from?.raw || data.from?.email,
    to: data.recipients?.to?.raw || (data.recipients?.to?.data ?? []).map((entry) => entry.email ?? "").filter(Boolean),
    cc: data.recipients?.cc?.raw || undefined,
    replyTo: header("reply-to"),
    subject: data.subject ?? "",
    date: date && !Number.isNaN(date.getTime()) ? date : undefined,
    messageId: header("message-id"),
    text: data.text || undefined,
    html: data.html || undefined,
    headers: headers.flatMap(([key, value]) =>
      COMPOSED_HEADERS.has(key.toLowerCase()) ? [] : (Array.isArray(value) ? value : [value]).map((entry) => ({ key, value: entry })),
    ),
    attachments: (data.attachments ?? [])
      .filter((file) => file.content)
      .map((file) => ({
        filename: file.filename || "attachment",
        contentType: file.content_type || "application/octet-stream",
        content: Buffer.from(file.content!, "base64"),
        cid: file.content_id?.replace(/^<|>$/g, "") || undefined,
      })),
  });
  const built = await new Promise<Buffer>((resolve, reject) =>
    composer.compile().build((error, output) => (error ? reject(error) : resolve(output))),
  );
  return new Uint8Array(built);
}

export function mailersendInboundHint(data: MailersendInboundData): InboundHint {
  const recipients = [
    ...(data.recipients?.rcptTo ?? []).map((entry) => entry.email),
    ...(data.recipients?.to?.data ?? []).map((entry) => entry.email),
    ...(data.recipients?.cc?.data ?? []).map((entry) => entry.email),
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.trim().toLowerCase());
  const spf = { "+": "pass", "-": "fail", "~": "softfail", "?": "neutral" }[data.spf_check?.code ?? ""];
  return { recipients: [...new Set(recipients)], ...(spf ? { authentication: { spf } } : {}) };
}

// The provider

export interface MailersendTarget {
  workspaceId: string;
  connectionId: string;
  apiKey: string;
  // Receiving domains, each with our inbound route's id and the MX it wants.
  inbound: Record<string, { routeId: string; mx: string }>;
}

export class MailersendProvider implements MailProvider {
  readonly kind = "mailersend" as const;
  // Inbound routing pushes the only copy, so there's nothing to backfill from.
  readonly capabilities = { receiving: true, backfill: false, refreshDomains: true };
  readonly api: MailersendApi;
  private readonly stored: StoredInbound;

  constructor(
    readonly target: MailersendTarget,
    fetcher: Fetch = fetch,
  ) {
    this.api = new MailersendApi(target.apiKey, fetcher);
    this.stored = new StoredInbound(target.workspaceId, target.connectionId);
  }

  async allDomains(): Promise<MailersendDomain[]> {
    const domains: MailersendDomain[] = [];
    for (let page = 1; page <= 30; page += 1) {
      const result = await this.api.call<{ data?: MailersendDomain[]; meta?: { last_page?: number } }>(
        "GET",
        `/v1/domains?limit=100&page=${page}`,
      );
      domains.push(...(result.data ?? []));
      if (!result.meta?.last_page || page >= result.meta.last_page) break;
    }
    return domains;
  }

  async listDomains(): Promise<ProviderDomain[]> {
    return (await this.allDomains()).map((domain) => {
      const name = domain.name.toLowerCase();
      return {
        id: domain.id,
        name,
        status: domain.is_verified ? "verified" : "pending",
        sending: domain.is_verified,
        receiving: name in this.target.inbound,
      };
    });
  }

  async send(message: OutgoingMessage): Promise<SentMessage> {
    const attachments = await Promise.all(
      (message.attachments ?? []).map(async (file) => ({
        filename: file.filename,
        contentId: file.contentId,
        content: new Uint8Array(await new Response(await readObject(file.storageKey)).arrayBuffer()),
      })),
    );
    let headers: Headers;
    try {
      ({ headers } = await this.api.request("POST", "/v1/email", mailersendMailBody(message, attachments)));
    } catch (error) {
      // The threading fields aren't allowed on every plan. The email still goes out.
      const threaded = Boolean(message.headers?.["In-Reply-To"] || message.headers?.References);
      if (!(threaded && error instanceof MailersendError && error.status === 422 && /reply|reference/i.test(error.message))) throw error;
      ({ headers } = await this.api.request("POST", "/v1/email", mailersendMailBody(message, attachments, { threading: false })));
    }
    // Events name the message by this id.
    const id = headers.get("x-message-id");
    if (!id) throw new MailersendError("MailerSend didn't send the email: every recipient is suppressed", 422);
    return { id };
  }

  async fetchInbound(id: string, hint?: InboundHint): Promise<InboundEmail> {
    const email = await this.stored.read(id, hint);
    if (!email) throw new Error(`MailerSend email ${id} isn't in storage`);
    return email;
  }

  async afterIngest(id: string) {
    await this.stored.remove(id);
  }

  // Domains

  async findDomain(name: string) {
    const domain = (await this.allDomains()).find((item) => item.name.toLowerCase() === name);
    if (!domain) throw new Error(`${name} isn't in this MailerSend account`);
    return domain;
  }

  async addDomain(name: string) {
    const existing = (await this.allDomains()).find((item) => item.name.toLowerCase() === name);
    if (!existing) await this.api.call("POST", "/v1/domains", { name });
    return this.domainRecords(name);
  }

  async domainRecords(name: string): Promise<DnsRecord[]> {
    const domain = await this.findDomain(name);
    // Asking MailerSend to check again saves people a trip to its dashboard.
    if (!domain.is_verified) await this.api.call("GET", `/v1/domains/${domain.id}/verify`).catch(() => undefined);
    const { data } = await this.api.call<{ data: Record<string, MailersendDnsRecord | string> }>("GET", `/v1/domains/${domain.id}/dns-records`);
    return mailersendDomainRecords(name, data ?? {}, {
      receiving: this.target.inbound[name]?.mx ?? null,
      needsDmarc: !(await hasDmarcPolicy(name)),
    });
  }

  // Receiving: an inbound route per domain, catching all its mail and posting it to us.
  // MailerSend checks the address with a test post before saving the route.
  async createRoute(domain: string, url: string) {
    const { id: domainId } = await this.findDomain(domain);
    const { data } = await this.api.call<{ data: { id: string; mxValues?: { target?: string } } }>("POST", "/v1/inbound", {
      domain_id: domainId,
      name: `HelloBox: ${domain}`.slice(0, 191),
      domain_enabled: true,
      inbound_domain: domain,
      inbound_priority: 0,
      catch_filter: { type: "catch_all" },
      match_filter: { type: "match_all" },
      include_attachments: true,
      forwards: [{ type: "webhook", value: url }],
    });
    return { routeId: data.id, mx: data.mxValues?.target?.replace(/\.$/, "") || MAILERSEND_INBOUND_MX };
  }

  async deleteRoute(routeId: string) {
    try {
      await this.api.call("DELETE", `/v1/inbound/${encodeURIComponent(routeId)}`);
    } catch (error) {
      if (!(error instanceof MailersendError && error.status === 404)) throw error;
    }
  }

  // Delivery events. MailerSend webhooks belong to one domain each.
  async createEventsWebhook(domainId: string, url: string) {
    const { data } = await this.api.call<{ data: { id: string; secret: string } }>("POST", "/v1/webhooks", {
      url,
      name: "HelloBox",
      events: EVENTS,
      enabled: true,
      version: 2,
      domain_id: domainId,
    });
    return { id: data.id, secret: data.secret };
  }

  async deleteWebhook(id: string) {
    try {
      await this.api.call("DELETE", `/v1/webhooks/${encodeURIComponent(id)}`);
    } catch (error) {
      if (!(error instanceof MailersendError && error.status === 404)) throw error;
    }
  }

  async disconnect(webhookIds: string[]) {
    for (const { routeId } of Object.values(this.target.inbound)) await this.deleteRoute(routeId);
    for (const id of webhookIds) await this.deleteWebhook(id);
  }
}
