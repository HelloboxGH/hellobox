import { readObject } from "@hellobox/storage";
import MailComposer from "nodemailer/lib/mail-composer";
import { dmarcRecord, hasDmarcPolicy } from "./dns";
import { StoredInbound } from "./pushed";
import type { DnsRecord, InboundEmail, InboundHint, MailProvider, OutgoingMessage, ProviderDomain, SentMessage } from "./types";

// Brevo (formerly Sendinblue), through its v3 API with the customer's API key. One host
// for every account.
export const BREVO_API = "https://api.brevo.com";

// Where inbound parsing receives mail: the receiving domain's MX points at both.
export const BREVO_INBOUND_MX = [
  { value: "inbound1.sendinblue.com", priority: 10 },
  { value: "inbound2.sendinblue.com", priority: 20 },
] as const;

export class BrevoError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "BrevoError";
  }
}

// The key was deleted or never worked. Brevo answers 401 with "unauthorized".
export const isBrevoAuthError = (error: unknown) =>
  error instanceof BrevoError && (error.status === 401 || error.code === "unauthorized");

type Fetch = typeof fetch;

export class BrevoApi {
  constructor(
    readonly apiKey: string,
    private readonly fetcher: Fetch = fetch,
  ) {}

  async response(method: string, path: string, body?: unknown) {
    const res = await this.fetcher(`${BREVO_API}${path}`, {
      method,
      headers: {
        "api-key": this.apiKey,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      let json: { code?: string; message?: string } | null = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      throw new BrevoError(brevoMessage(json, res.status), res.status, json?.code);
    }
    return res;
  }

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const text = await (await this.response(method, path, body)).text();
    return (text ? JSON.parse(text) : null) as T;
  }
}

// Brevo answers errors as { code, message }.
function brevoMessage(json: { code?: string; message?: string } | null, status: number) {
  if (status === 401 || json?.code === "unauthorized") return "Brevo didn't accept the API key";
  if (json?.message) return json.message;
  return `Brevo answered ${status}`;
}

// Domains

export interface BrevoDnsRecord {
  type?: string;
  value?: string;
  host_name?: string;
  status?: boolean;
}

export interface BrevoDomain {
  domain_name: string;
  authenticated: boolean;
  verified: boolean;
}

export interface BrevoDomainConfig {
  domain: string;
  verified: boolean;
  authenticated: boolean;
  dns_records?: Record<string, BrevoDnsRecord | undefined>;
}

const PURPOSES: Record<string, string> = {
  brevo_code: "Proves to Brevo that the domain is yours",
  dkim_record: "Signs your mail with DKIM",
  dkim1Record: "Signs your mail with DKIM",
  dkim2Record: "Signs your mail with DKIM (second key)",
};

// Brevo names hosts relative to the domain ("@", "mail._domainkey"), and sometimes in full.
function fullName(host: string, domain: string) {
  const name = host.toLowerCase().replace(/\.$/, "");
  if (name === "@" || name === "") return domain;
  if (name === domain || name.endsWith(`.${domain}`)) return name;
  return `${name}.${domain}`;
}

// Brevo's records, DMARC (Brevo's own suggestion is left out: ours is the same policy),
// and the MX when the domain receives.
export function brevoDomainRecords(config: BrevoDomainConfig, options: { receiving: boolean; needsDmarc: boolean }): DnsRecord[] {
  const domain = config.domain.toLowerCase();
  const records: DnsRecord[] = [];
  for (const [key, record] of Object.entries(config.dns_records ?? {})) {
    if (key === "dmarc_record") continue;
    const type = record?.type?.toUpperCase();
    if (!record?.host_name || !record.value || (type !== "CNAME" && type !== "TXT")) continue;
    records.push({ type, name: fullName(record.host_name, domain), value: record.value, purpose: PURPOSES[key] ?? "Needed by Brevo" });
  }
  if (options.needsDmarc) records.push(dmarcRecord(domain));
  if (options.receiving) {
    for (const mx of BREVO_INBOUND_MX) {
      records.push({
        type: "MX",
        name: domain,
        value: mx.value,
        priority: mx.priority,
        purpose: "Delivers mail for this domain to Brevo, which passes it to HelloBox",
        keepExisting: true,
      });
    }
  }
  return records;
}

// Sending

// "Ada <ada@example.com>" → { email, name }.
export function brevoAddress(value: string): { email: string; name?: string } {
  const match = value.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (!match) return { email: value.trim() };
  const name = match[1]?.replace(/^"|"$/g, "").trim();
  return { email: match[2]!.trim(), ...(name ? { name: name.slice(0, 70) } : {}) };
}

// Brevo writes its own Message-ID and refuses standard headers in `headers`, so ours is
// left out and Brevo's is kept instead. The threading headers are tried; see send().
const THREADING = ["In-Reply-To", "References"];

export function brevoMailBody(
  message: OutgoingMessage,
  attachments: { filename: string; content: Uint8Array }[],
  options: { threading: boolean } = { threading: true },
) {
  const list = (values: string[] | undefined) => (values?.length ? values.map(brevoAddress) : undefined);
  const headers = Object.fromEntries(
    Object.entries(message.headers ?? {}).filter(([name]) => name !== "Message-ID" && (options.threading || !THREADING.includes(name))),
  );
  const tags = Object.entries(message.tags ?? {}).map(([key, value]) => `${key}:${value}`);
  return {
    sender: brevoAddress(message.from),
    to: list(message.to),
    cc: list(message.cc),
    bcc: list(message.bcc),
    // Brevo takes one reply-to address.
    ...(message.replyTo?.[0] ? { replyTo: brevoAddress(message.replyTo[0]) } : {}),
    subject: message.subject,
    ...(message.html ? { htmlContent: message.html } : {}),
    ...(message.text || !message.html ? { textContent: message.text || " " } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(tags.length ? { tags } : {}),
    ...(attachments.length
      ? { attachment: attachments.map((file) => ({ name: file.filename, content: Buffer.from(file.content).toString("base64") })) }
      : {}),
  };
}

export const stripBrackets = (value: string) => value.trim().replace(/^<|>$/g, "");

// Events

export interface BrevoEvent {
  event?: string;
  email?: string;
  id?: number;
  "message-id"?: string;
  reason?: string;
  ts_event?: number;
  ts_epoch?: number;
  tags?: string[];
}

// Brevo events, mapped onto the delivery statuses the inbox already shows. A soft bounce
// or a deferral is retried by Brevo; "blocked", "invalid" and "error" were never sent,
// which says nothing about the address.
export function brevoDeliveryType(event: BrevoEvent) {
  switch (event.event) {
    case "delivered":
      return "email.delivered";
    case "hard_bounce":
    case "hardBounce":
      return "email.bounced";
    case "soft_bounce":
    case "softBounce":
    case "deferred":
      return "email.delivery_delayed";
    case "spam":
      return "email.complained";
    case "blocked":
    case "invalid":
    case "invalid_email":
    case "error":
      return "email.failed";
    default:
      return null;
  }
}

export function brevoEventDetail(event: BrevoEvent): { recipients: string[]; reason?: string } {
  const recipient = event.email?.trim().toLowerCase();
  return { recipients: recipient ? [recipient] : [], reason: event.event === "delivered" ? undefined : event.reason || undefined };
}

// The same event posted twice has the same id.
export const brevoEventId = (event: BrevoEvent) =>
  `${event.event ?? ""}:${stripBrackets(event["message-id"] ?? "")}:${event.email?.toLowerCase() ?? ""}:${event.ts_epoch ?? event.ts_event ?? ""}`;

// Inbound parsing

interface BrevoMailbox {
  Name?: string | null;
  Address: string;
}

export interface BrevoInboundAttachment {
  Name?: string;
  ContentType?: string;
  ContentLength?: number;
  ContentID?: string | null;
  DownloadToken: string;
}

export interface BrevoInboundItem {
  Uuid?: string[];
  MessageId?: string;
  InReplyTo?: string | null;
  From?: BrevoMailbox;
  To?: BrevoMailbox[];
  Cc?: BrevoMailbox[] | null;
  ReplyTo?: BrevoMailbox | null;
  // The docs show both addresses and mailboxes here.
  Recipients?: (string | BrevoMailbox)[];
  SentAtDate?: string;
  Subject?: string;
  RawHtmlBody?: string | null;
  RawTextBody?: string | null;
  Attachments?: BrevoInboundAttachment[] | null;
  Headers?: Record<string, string | string[]>;
}

const formatMailbox = (mailbox: BrevoMailbox) =>
  mailbox.Name ? `"${mailbox.Name.replace(/["\\]/g, "")}" <${mailbox.Address}>` : mailbox.Address;

// Headers the composer writes itself from the fields.
const COMPOSED_HEADERS = new Set([
  "from", "to", "cc", "bcc", "reply-to", "subject", "date", "message-id", "mime-version",
  "content-type", "content-transfer-encoding",
]);

// Brevo has no raw message, so it's rebuilt from the parsed fields, the original headers
// (threading included) and the attachments, downloaded by the caller.
export async function brevoInboundRaw(item: BrevoInboundItem, files: { attachment: BrevoInboundAttachment; content: Uint8Array }[]) {
  const headers = Object.entries(item.Headers ?? {}).flatMap(([key, value]) =>
    COMPOSED_HEADERS.has(key.toLowerCase()) ? [] : (Array.isArray(value) ? value : [value]).map((entry) => ({ key, value: entry })),
  );
  const date = item.SentAtDate ? new Date(item.SentAtDate) : undefined;
  const composer = new MailComposer({
    from: item.From ? formatMailbox(item.From) : undefined,
    to: (item.To ?? []).map(formatMailbox),
    cc: (item.Cc ?? []).map(formatMailbox),
    replyTo: item.ReplyTo ? formatMailbox(item.ReplyTo) : undefined,
    subject: item.Subject ?? "",
    date: date && !Number.isNaN(date.getTime()) ? date : undefined,
    messageId: item.MessageId || undefined,
    text: item.RawTextBody || undefined,
    html: item.RawHtmlBody || undefined,
    headers,
    attachments: files.map(({ attachment, content }) => ({
      filename: attachment.Name || "attachment",
      contentType: attachment.ContentType || "application/octet-stream",
      content: Buffer.from(content),
      cid: attachment.ContentID?.replace(/^<|>$/g, "") || undefined,
    })),
  });
  const built = await new Promise<Buffer>((resolve, reject) =>
    composer.compile().build((error, output) => (error ? reject(error) : resolve(output))),
  );
  return new Uint8Array(built);
}

// Who the email was delivered to, Bcc included when Brevo lists it.
export function brevoInboundHint(item: BrevoInboundItem): InboundHint {
  const recipients = [
    ...(item.Recipients ?? []).map((entry) => (typeof entry === "string" ? entry : entry.Address)),
    ...[...(item.To ?? []), ...(item.Cc ?? [])].map((mailbox) => mailbox.Address),
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.trim().toLowerCase());
  return { recipients: [...new Set(recipients)] };
}

// The provider

export interface BrevoTarget {
  workspaceId: string;
  connectionId: string;
  apiKey: string;
  // Receiving domains, each with the id of our inbound webhook for it.
  inbound: Record<string, string>;
}

export class BrevoProvider implements MailProvider {
  readonly kind = "brevo" as const;
  // Inbound parsing pushes the only copy, so there's nothing to backfill from.
  readonly capabilities = { receiving: true, backfill: false, refreshDomains: true };
  readonly api: BrevoApi;
  private readonly stored: StoredInbound;

  constructor(
    readonly target: BrevoTarget,
    fetcher: Fetch = fetch,
  ) {
    this.api = new BrevoApi(target.apiKey, fetcher);
    this.stored = new StoredInbound(target.workspaceId, target.connectionId);
  }

  // Checks the key.
  async account() {
    return this.api.call<{ email?: string; companyName?: string }>("GET", "/v3/account");
  }

  async allDomains(): Promise<BrevoDomain[]> {
    const { domains } = await this.api.call<{ domains?: BrevoDomain[] }>("GET", "/v3/senders/domains");
    return domains ?? [];
  }

  async listDomains(): Promise<ProviderDomain[]> {
    return (await this.allDomains()).map((domain) => {
      const name = domain.domain_name.toLowerCase();
      return {
        id: name,
        name,
        status: domain.authenticated ? "verified" : "pending",
        sending: domain.authenticated,
        receiving: name in this.target.inbound,
      };
    });
  }

  async send(message: OutgoingMessage): Promise<SentMessage> {
    const attachments = await Promise.all(
      (message.attachments ?? []).map(async (file) => ({
        filename: file.filename,
        content: new Uint8Array(await new Response(await readObject(file.storageKey)).arrayBuffer()),
      })),
    );
    let sent: { messageId?: string };
    try {
      sent = await this.api.call("POST", "/v3/smtp/email", brevoMailBody(message, attachments));
    } catch (error) {
      // Should Brevo refuse the threading headers, the email still goes out without them.
      const threaded = THREADING.some((name) => message.headers?.[name]);
      if (!(threaded && error instanceof BrevoError && error.status === 400 && /header/i.test(error.message))) throw error;
      sent = await this.api.call("POST", "/v3/smtp/email", brevoMailBody(message, attachments, { threading: false }));
    }
    // Brevo's Message-ID: events name the message by it, and replies point at it.
    const messageId = sent.messageId ? stripBrackets(sent.messageId) : null;
    if (!messageId) return { id: message.headers?.["Message-ID"] ? stripBrackets(message.headers["Message-ID"]) : crypto.randomUUID() };
    return { id: messageId, messageIdHeader: `<${messageId}>` };
  }

  async fetchInbound(id: string, hint?: InboundHint): Promise<InboundEmail> {
    const email = await this.stored.read(id, hint);
    if (!email) throw new Error(`Brevo email ${id} isn't in storage`);
    return email;
  }

  async afterIngest(id: string) {
    await this.stored.remove(id);
  }

  async downloadAttachment(token: string) {
    const res = await this.api.response("GET", `/v3/inbound/attachments/${encodeURIComponent(token)}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  // Domains

  async domainConfig(name: string) {
    return this.api.call<BrevoDomainConfig>("GET", `/v3/senders/domains/${encodeURIComponent(name)}`);
  }

  async addDomain(name: string) {
    const existing = (await this.allDomains()).find((item) => item.domain_name.toLowerCase() === name);
    if (!existing) await this.api.call("POST", "/v3/senders/domains", { name });
    return this.domainRecords(name);
  }

  async domainRecords(name: string): Promise<DnsRecord[]> {
    let config = await this.domainConfig(name);
    // Asking Brevo to check again saves people a trip to its dashboard. It refuses until
    // the records are there.
    if (!config.authenticated) {
      await this.api.call("PUT", `/v3/senders/domains/${encodeURIComponent(name)}/authenticate`).catch(() => undefined);
      config = await this.domainConfig(name);
    }
    return brevoDomainRecords(config, { receiving: name in this.target.inbound, needsDmarc: !(await hasDmarcPolicy(name)) });
  }

  // Webhooks. Brevo doesn't sign them: each carries the connection's token, as a bearer
  // token and in a header of ours.

  private webhookAuth(token: string) {
    return { auth: { type: "bearer", token }, headers: [{ key: "X-HelloBox-Token", value: token }] };
  }

  async createInboundWebhook(domain: string, url: string, token: string) {
    const { id } = await this.api.call<{ id: number }>("POST", "/v3/webhooks", {
      type: "inbound",
      events: ["inboundEmailProcessed"],
      domain,
      url,
      description: `HelloBox: mail for ${domain}`,
      ...this.webhookAuth(token),
    });
    return String(id);
  }

  async createEventsWebhook(url: string, token: string) {
    const { id } = await this.api.call<{ id: number }>("POST", "/v3/webhooks", {
      type: "transactional",
      events: ["delivered", "hardBounce", "softBounce", "blocked", "spam", "invalid", "deferred"],
      url,
      description: "HelloBox: delivery events",
      ...this.webhookAuth(token),
    });
    return String(id);
  }

  async deleteWebhook(id: string) {
    try {
      await this.api.call("DELETE", `/v3/webhooks/${encodeURIComponent(id)}`);
    } catch (error) {
      if (!(error instanceof BrevoError && error.status === 404)) throw error;
    }
  }

  async disconnect(eventsWebhookId: string | null) {
    for (const id of Object.values(this.target.inbound)) await this.deleteWebhook(id);
    if (eventsWebhookId) await this.deleteWebhook(eventsWebhookId);
  }
}
