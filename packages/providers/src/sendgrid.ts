import { createPublicKey, verify as verifySignature } from "node:crypto";
import { readObject } from "@hellobox/storage";
import { dmarcRecord, hasDmarcPolicy } from "./dns";
import { StoredInbound } from "./pushed";
import type { DnsRecord, InboundEmail, InboundHint, MailProvider, OutgoingMessage, ProviderDomain, SentMessage } from "./types";

// Twilio SendGrid, through its v3 API with the customer's API key. EU subusers live on
// their own host, and a key only works on its own.
export type SendgridRegion = "global" | "eu";

export const SENDGRID_API: Record<SendgridRegion, string> = {
  global: "https://api.sendgrid.com",
  eu: "https://api.eu.sendgrid.com",
};

// Where Inbound Parse receives mail: the receiving domain's MX points here.
export const SENDGRID_INBOUND_MX = "mx.sendgrid.net";

export class SendgridError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SendgridError";
  }
}

// The key was deleted or never worked. 403 is a key missing a permission, which a new key
// with Full Access fixes too, but it says so in its message instead.
export const isSendgridAuthError = (error: unknown) => error instanceof SendgridError && error.status === 401;

type Fetch = typeof fetch;

export class SendgridApi {
  constructor(
    readonly apiKey: string,
    readonly region: SendgridRegion,
    private readonly fetcher: Fetch = fetch,
  ) {}

  async request(method: string, path: string, body?: unknown): Promise<{ json: unknown; headers: Headers }> {
    const res = await this.fetcher(`${SENDGRID_API[this.region]}${path}`, {
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
    if (!res.ok) throw new SendgridError(sendgridMessage(json, res.status), res.status);
    return { json, headers: res.headers };
  }

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await this.request(method, path, body)).json as T;
  }
}

// SendGrid answers errors as { errors: [{ message, field }] }.
function sendgridMessage(json: unknown, status: number) {
  const errors = (json as { errors?: { message?: string; field?: string | null }[] } | null)?.errors;
  const messages = (errors ?? []).map((error) => error.message).filter(Boolean);
  if (messages.length) return messages.join(" ");
  if (status === 401) return "SendGrid didn't accept the API key";
  if (status === 403) return "The API key doesn't have the permissions HelloBox needs. Use a key with Full Access.";
  return `SendGrid answered ${status}`;
}

// The region whose host accepts the key, or null when neither does.
export async function detectSendgridRegion(apiKey: string, fetcher: Fetch = fetch): Promise<SendgridRegion | null> {
  for (const region of ["global", "eu"] as const) {
    try {
      await new SendgridApi(apiKey, region, fetcher).call("GET", "/v3/whitelabel/domains?limit=1");
      return region;
    } catch (error) {
      if (!isSendgridAuthError(error)) throw error;
    }
  }
  return null;
}

// Domains

interface SendgridDnsRecord {
  valid?: boolean;
  type?: string;
  host?: string;
  data?: string;
}

export interface SendgridDomain {
  id: number;
  domain: string;
  subdomain?: string;
  valid: boolean;
  automatic_security?: boolean;
  dns?: Record<string, SendgridDnsRecord | undefined>;
}

const PURPOSES: Record<string, string> = {
  mail_cname: "Lets SendGrid send for your domain and handle its bounces",
  dkim1: "Signs your mail with DKIM",
  dkim2: "Signs your mail with DKIM (second key, for rotation)",
};

// SendGrid's authentication records, DMARC, and the MX when the domain receives.
export function sendgridDomainRecords(domain: SendgridDomain, options: { receiving: boolean; needsDmarc: boolean }): DnsRecord[] {
  const records: DnsRecord[] = [];
  for (const [key, record] of Object.entries(domain.dns ?? {})) {
    const type = record?.type?.toUpperCase();
    if (!record?.host || !record.data || (type !== "CNAME" && type !== "TXT" && type !== "MX")) continue;
    records.push({
      type,
      name: record.host.toLowerCase().replace(/\.$/, ""),
      value: record.data,
      ...(type === "MX" ? { priority: 10 } : {}),
      purpose: PURPOSES[key] ?? "Needed by SendGrid",
    });
  }
  if (options.needsDmarc) records.push(dmarcRecord(domain.domain));
  if (options.receiving) {
    records.push({
      type: "MX",
      name: domain.domain,
      value: SENDGRID_INBOUND_MX,
      priority: 10,
      purpose: "Delivers mail for this domain to SendGrid, which passes it to HelloBox",
      keepExisting: true,
    });
  }
  return records;
}

// Sending

// "Ada <ada@example.com>" → { email, name }. SendGrid wants addresses split.
export function sendgridAddress(value: string): { email: string; name?: string } {
  const match = value.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (!match) return { email: value.trim() };
  const name = match[1]?.replace(/^"|"$/g, "").trim();
  return { email: match[2]!.trim(), ...(name ? { name } : {}) };
}

// The JSON for /v3/mail/send. Our Message-ID and threading headers go in `headers`, which
// SendGrid keeps (it only refuses To, From, Subject and the like there). Tags become
// custom_args, which come back on every event.
export function sendgridMailBody(
  message: OutgoingMessage,
  attachments: { filename: string; contentType: string; contentId?: string; content: Uint8Array }[],
) {
  const list = (values: string[] | undefined) => (values?.length ? values.map(sendgridAddress) : undefined);
  const text = message.text ?? (message.html ? undefined : " ");
  const content = [
    ...(text ? [{ type: "text/plain", value: text }] : []),
    ...(message.html ? [{ type: "text/html", value: message.html }] : []),
  ];
  return {
    personalizations: [
      {
        to: list(message.to),
        cc: list(message.cc),
        bcc: list(message.bcc),
        ...(message.tags && Object.keys(message.tags).length ? { custom_args: message.tags } : {}),
      },
    ],
    from: sendgridAddress(message.from),
    ...(message.replyTo?.length ? { reply_to_list: message.replyTo.map(sendgridAddress) } : {}),
    subject: message.subject,
    content,
    ...(message.headers && Object.keys(message.headers).length ? { headers: message.headers } : {}),
    ...(attachments.length
      ? {
          attachments: attachments.map((file) => ({
            content: Buffer.from(file.content).toString("base64"),
            filename: file.filename,
            type: file.contentType,
            disposition: file.contentId ? "inline" : "attachment",
            ...(file.contentId ? { content_id: file.contentId } : {}),
          })),
        }
      : {}),
  };
}

// Events

export interface SendgridEvent {
  event?: string;
  email?: string;
  sg_message_id?: string;
  sg_event_id?: string;
  // On a bounce: "bounce" is permanent, "blocked" is temporary.
  type?: string;
  reason?: string;
  response?: string;
  status?: string;
  timestamp?: number;
}

// Events name the message "<X-Message-Id>.filter…" (or ".recvd-…"). The part before is
// the id the send returned.
export function sendgridMessageId(event: SendgridEvent) {
  const value = event.sg_message_id?.trim();
  if (!value) return null;
  const cut = value.search(/\.(filter|recvd|ismtpd)/);
  return cut > 0 ? value.slice(0, cut) : value;
}

// SendGrid events, mapped onto the delivery statuses the inbox already shows. A dropped
// email was never sent, which says nothing about the address.
export function sendgridDeliveryType(event: SendgridEvent) {
  switch (event.event) {
    case "delivered":
      return "email.delivered";
    case "spamreport":
      return "email.complained";
    case "bounce":
      return event.type === "blocked" ? "email.delivery_delayed" : "email.bounced";
    case "deferred":
      return "email.delivery_delayed";
    case "dropped":
      return "email.failed";
    default:
      return null;
  }
}

export function sendgridEventDetail(event: SendgridEvent): { recipients: string[]; reason?: string } {
  const recipient = event.email?.trim().toLowerCase();
  const reason = event.event === "delivered" ? undefined : event.reason || event.response || undefined;
  return { recipients: recipient ? [recipient] : [], reason };
}

// A signed event post: ECDSA (P-256, SHA-256) over the timestamp followed by the raw
// body. The key comes as base64 DER, or as PEM.
export function verifySendgridSignature(
  publicKey: string,
  input: { signature: string | null; timestamp: string | null; body: Uint8Array },
  now = Date.now(),
  maxAgeSeconds = 600,
) {
  if (!input.signature || !input.timestamp) return false;
  const seconds = Number(input.timestamp);
  if (!Number.isFinite(seconds) || Math.abs(now / 1000 - seconds) > maxAgeSeconds) return false;
  try {
    const key = publicKey.includes("BEGIN PUBLIC KEY")
      ? createPublicKey(publicKey)
      : createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
    const signed = Buffer.concat([Buffer.from(input.timestamp, "utf8"), Buffer.from(input.body)]);
    return verifySignature("sha256", signed, { key, dsaEncoding: "der" }, Buffer.from(input.signature, "base64"));
  } catch {
    return false;
  }
}

// The provider

export interface SendgridTarget {
  workspaceId: string;
  connectionId: string;
  apiKey: string;
  region: SendgridRegion;
  // Domains with an Inbound Parse setting of ours.
  receiving: string[];
}

export class SendgridProvider implements MailProvider {
  readonly kind = "sendgrid" as const;
  // Inbound Parse pushes the only copy, so there's nothing to backfill from.
  readonly capabilities = { receiving: true, backfill: false, refreshDomains: true };
  readonly api: SendgridApi;
  private readonly stored: StoredInbound;

  constructor(
    readonly target: SendgridTarget,
    fetcher: Fetch = fetch,
  ) {
    this.api = new SendgridApi(target.apiKey, target.region, fetcher);
    this.stored = new StoredInbound(target.workspaceId, target.connectionId);
  }

  async allDomains(): Promise<SendgridDomain[]> {
    const domains: SendgridDomain[] = [];
    for (let offset = 0; offset < 3000; offset += 200) {
      const page = await this.api.call<SendgridDomain[]>("GET", `/v3/whitelabel/domains?limit=200&offset=${offset}`);
      domains.push(...page);
      if (page.length < 200) break;
    }
    return domains;
  }

  async listDomains(): Promise<ProviderDomain[]> {
    const receiving = new Set(this.target.receiving);
    return (await this.allDomains()).map((domain) => {
      const name = domain.domain.toLowerCase();
      return {
        id: String(domain.id),
        name,
        status: domain.valid ? "verified" : "pending",
        sending: domain.valid,
        receiving: receiving.has(name),
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
    const { headers } = await this.api.request("POST", "/v3/mail/send", sendgridMailBody(message, attachments));
    // Events name the message by this id. Without it they couldn't be matched, but the
    // email did go out.
    const id = headers.get("x-message-id") ?? message.headers?.["Message-ID"]?.replace(/^<|>$/g, "") ?? crypto.randomUUID();
    return { id };
  }

  async fetchInbound(id: string, hint?: InboundHint): Promise<InboundEmail> {
    const email = await this.stored.read(id, hint);
    if (!email) throw new Error(`SendGrid email ${id} isn't in storage`);
    return email;
  }

  async afterIngest(id: string) {
    await this.stored.remove(id);
  }

  // Domains

  private async findDomain(name: string) {
    const domain = (await this.allDomains()).find((item) => item.domain.toLowerCase() === name);
    if (!domain) throw new Error(`${name} isn't authenticated in this SendGrid account`);
    return domain;
  }

  // Automated security: SendGrid's records are CNAMEs it can rotate keys behind.
  async addDomain(name: string) {
    const existing = (await this.allDomains()).find((item) => item.domain.toLowerCase() === name);
    if (!existing) await this.api.call("POST", "/v3/whitelabel/domains", { domain: name, automatic_security: true });
    return this.domainRecords(name);
  }

  async domainRecords(name: string): Promise<DnsRecord[]> {
    let domain = await this.findDomain(name);
    // Asking SendGrid to check again saves people a trip to its dashboard.
    if (!domain.valid) {
      await this.api.call("POST", `/v3/whitelabel/domains/${domain.id}/validate`).catch(() => undefined);
      domain = await this.findDomain(name);
    }
    return sendgridDomainRecords(domain, {
      receiving: this.target.receiving.includes(name),
      needsDmarc: !(await hasDmarcPolicy(name)),
    });
  }

  // Receiving

  // One Inbound Parse setting per receiving domain, posting the raw message to us.
  async createParse(hostname: string, url: string) {
    try {
      await this.api.call("POST", "/v3/user/webhooks/parse/settings", { hostname, url, spam_check: false, send_raw: true });
    } catch (error) {
      // Already there, perhaps from an earlier connection: point it at us.
      if (!(error instanceof SendgridError && error.status === 400)) throw error;
      await this.api.call("PATCH", `/v3/user/webhooks/parse/settings/${encodeURIComponent(hostname)}`, { url, spam_check: false, send_raw: true });
    }
  }

  async deleteParse(hostname: string) {
    try {
      await this.api.call("DELETE", `/v3/user/webhooks/parse/settings/${encodeURIComponent(hostname)}`);
    } catch (error) {
      if (!(error instanceof SendgridError && error.status === 404)) throw error;
    }
  }

  // Delivery events. Signing is turned on separately, and returns the key to check with.
  async createEventsWebhook(url: string) {
    const { id } = await this.api.call<{ id: string }>("POST", "/v3/user/webhooks/event/settings", {
      url,
      enabled: true,
      friendly_name: "HelloBox",
      delivered: true,
      bounce: true,
      dropped: true,
      deferred: true,
      spam_report: true,
    });
    const { public_key } = await this.api.call<{ public_key: string }>("PATCH", `/v3/user/webhooks/event/settings/signed/${id}`, {
      enabled: true,
    });
    return { id, publicKey: public_key };
  }

  async deleteEventsWebhook(id: string) {
    try {
      await this.api.call("DELETE", `/v3/user/webhooks/event/settings/${id}`);
    } catch (error) {
      if (!(error instanceof SendgridError && error.status === 404)) throw error;
    }
  }

  async disconnect(eventsWebhookId: string | null) {
    for (const hostname of this.target.receiving) await this.deleteParse(hostname);
    if (eventsWebhookId) await this.deleteEventsWebhook(eventsWebhookId);
  }
}
