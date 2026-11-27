import { readObject } from "@hellobox/storage";
import MailComposer from "nodemailer/lib/mail-composer";
import { dmarcRecord, hasDmarcPolicy } from "./dns";
import { StoredInbound } from "./pushed";
import type { DnsRecord, InboundEmail, InboundHint, MailProvider, OutgoingMessage, ProviderDomain, SentMessage } from "./types";

// Mailjet, through its v3 REST and v3.1 Send APIs, with the customer's API key and secret
// key (HTTP Basic). One host for every account.
export const MAILJET_API = "https://api.mailjet.com";

// Where the Parse API receives mail for a domain of the customer's.
export const MAILJET_INBOUND_MX = "parse.mailjet.com";

export class MailjetError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MailjetError";
  }
}

export const isMailjetAuthError = (error: unknown) => error instanceof MailjetError && error.status === 401;

type Fetch = typeof fetch;

export class MailjetApi {
  constructor(
    readonly apiKey: string,
    readonly secretKey: string,
    private readonly fetcher: Fetch = fetch,
  ) {}

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetcher(`${MAILJET_API}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.apiKey}:${this.secretKey}`).toString("base64")}`,
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
    if (!res.ok) throw new MailjetError(mailjetErrorText(json, res.status), res.status);
    return json as T;
  }
}

// REST errors are { ErrorInfo, ErrorMessage, StatusCode }; sends answer per message,
// with Messages[].Errors[].ErrorMessage.
function mailjetErrorText(json: unknown, status: number) {
  if (status === 401) return "Mailjet didn't accept the API key and secret key";
  const body = json as {
    ErrorMessage?: string;
    ErrorInfo?: string;
    Messages?: { Errors?: { ErrorMessage?: string }[] }[];
  } | null;
  const sendErrors = (body?.Messages ?? []).flatMap((message) => message.Errors ?? []).map((error) => error.ErrorMessage).filter(Boolean);
  if (sendErrors.length) return sendErrors.join(" ");
  if (body?.ErrorMessage) return body.ErrorInfo ? `${body.ErrorMessage}: ${body.ErrorInfo}` : body.ErrorMessage;
  return `Mailjet answered ${status}`;
}

// Domains

export interface MailjetDns {
  ID: number;
  Domain: string;
  DKIMRecordName?: string;
  DKIMRecordValue?: string;
  DKIMStatus?: string;
  SPFRecordValue?: string;
  SPFStatus?: string;
  OwnerShipToken?: string;
  OwnerShipTokenRecordName?: string;
}

export interface MailjetSender {
  ID: number;
  Email: string;
  Status?: string;
}

// Mailjet names records in full, with a final dot, or relative to the domain.
function fullName(host: string, domain: string) {
  const name = host.toLowerCase().replace(/\.$/, "");
  if (name === "@" || name === "") return domain;
  if (name === domain || name.endsWith(`.${domain}`)) return name;
  return `${name}.${domain}`;
}

const unquote = (value: string) => value.trim().replace(/^"|"$/g, "");

// The ownership token, DKIM and SPF, then DMARC and the MX when the domain receives.
export function mailjetDomainRecords(dns: MailjetDns, options: { receiving: boolean; needsDmarc: boolean }): DnsRecord[] {
  const domain = dns.Domain.toLowerCase();
  const records: DnsRecord[] = [];
  if (dns.OwnerShipTokenRecordName && dns.OwnerShipToken) {
    records.push({
      type: "TXT",
      name: fullName(dns.OwnerShipTokenRecordName, domain),
      value: unquote(dns.OwnerShipToken),
      purpose: "Proves to Mailjet that the domain is yours",
    });
  }
  if (dns.DKIMRecordName && dns.DKIMRecordValue) {
    records.push({ type: "TXT", name: fullName(dns.DKIMRecordName, domain), value: unquote(dns.DKIMRecordValue), purpose: "Signs your mail with DKIM" });
  }
  if (dns.SPFRecordValue) {
    // A domain has one SPF record. One that's already there needs Mailjet merged in.
    records.push({ type: "TXT", name: domain, value: unquote(dns.SPFRecordValue), purpose: "Lets Mailjet send for your domain (SPF)", keepExisting: true });
  }
  if (options.needsDmarc) records.push(dmarcRecord(domain));
  if (options.receiving) {
    records.push({
      type: "MX",
      name: domain,
      value: MAILJET_INBOUND_MX,
      priority: 10,
      purpose: "Delivers mail for this domain to Mailjet, which passes it to HelloBox",
      keepExisting: true,
    });
  }
  return records;
}

// Sending

export function mailjetAddress(value: string): { Email: string; Name?: string } {
  const match = value.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (!match) return { Email: value.trim() };
  const name = match[1]?.replace(/^"|"$/g, "").trim();
  return { Email: match[2]!.trim(), ...(name ? { Name: name } : {}) };
}

const THREADING = ["Message-ID", "In-Reply-To", "References"];

// Every recipient gets a MessageID of their own, so the message is named by CustomID
// instead, which comes back on every event: our Message-ID without brackets.
export const mailjetCustomId = (message: OutgoingMessage) =>
  (message.headers?.["Message-ID"]?.replace(/^<|>$/g, "") ?? crypto.randomUUID()).slice(0, 64);

// One message for /v3.1/send. Our Message-ID and threading headers go in Headers;
// see send() for when Mailjet refuses them.
export function mailjetMessage(
  message: OutgoingMessage,
  attachments: { filename: string; contentType: string; contentId?: string; content: Uint8Array }[],
  options: { threading: boolean } = { threading: true },
) {
  const list = (values: string[] | undefined) => (values?.length ? values.map(mailjetAddress) : undefined);
  const headers = Object.fromEntries(Object.entries(message.headers ?? {}).filter(([name]) => options.threading || !THREADING.includes(name)));
  const file = (attachment: (typeof attachments)[number]) => ({
    Filename: attachment.filename,
    ContentType: attachment.contentType,
    Base64Content: Buffer.from(attachment.content).toString("base64"),
  });
  const inline = attachments.filter((attachment) => attachment.contentId);
  const attached = attachments.filter((attachment) => !attachment.contentId);
  return {
    From: mailjetAddress(message.from),
    To: list(message.to),
    Cc: list(message.cc),
    Bcc: list(message.bcc),
    ...(message.replyTo?.[0] ? { ReplyTo: mailjetAddress(message.replyTo[0]) } : {}),
    Subject: message.subject,
    ...(message.html ? { HTMLPart: message.html } : {}),
    ...(message.text || !message.html ? { TextPart: message.text || " " } : {}),
    ...(Object.keys(headers).length ? { Headers: headers } : {}),
    CustomID: mailjetCustomId(message),
    ...(message.tags && Object.keys(message.tags).length ? { EventPayload: JSON.stringify(message.tags) } : {}),
    ...(attached.length ? { Attachments: attached.map(file) } : {}),
    ...(inline.length ? { InlinedAttachments: inline.map((attachment) => ({ ...file(attachment), ContentID: attachment.contentId })) } : {}),
  };
}

// Events

export interface MailjetEvent {
  event?: string;
  time?: number;
  email?: string;
  MessageID?: number;
  Message_GUID?: string;
  CustomID?: string;
  hard_bounce?: boolean;
  blocked?: boolean;
  error_related_to?: string;
  error?: string;
  comment?: string;
  smtp_reply?: string;
}

// Mailjet's "sent" is the receiving server accepting the email: what the inbox calls
// Delivered. A soft bounce is retried, so it's a delay. Blocked mail was never sent.
export function mailjetDeliveryType(event: MailjetEvent) {
  switch (event.event) {
    case "sent":
      return "email.delivered";
    case "bounce":
      return event.hard_bounce ? "email.bounced" : "email.delivery_delayed";
    case "blocked":
      return "email.failed";
    case "spam":
      return "email.complained";
    default:
      return null;
  }
}

export function mailjetEventDetail(event: MailjetEvent): { recipients: string[]; reason?: string } {
  const recipient = event.email?.trim().toLowerCase();
  const reason = event.event === "sent" ? undefined : [event.error, event.comment].filter(Boolean).join(": ") || undefined;
  return { recipients: recipient ? [recipient] : [], reason };
}

// The id the send returned, so events find the message.
export const mailjetEventMessageId = (event: MailjetEvent) => event.CustomID || (event.MessageID ? String(event.MessageID) : null);

export const mailjetEventId = (event: MailjetEvent) =>
  `${event.event ?? ""}:${event.Message_GUID ?? event.MessageID ?? ""}:${event.email?.toLowerCase() ?? ""}:${event.time ?? ""}`;

// The events HelloBox listens to: one callback address each.
export const MAILJET_EVENTS = ["sent", "bounce", "blocked", "spam"] as const;

// Parse API

export interface MailjetInbound {
  Sender?: string;
  Recipient?: string;
  From?: string;
  Subject?: string;
  Headers?: Record<string, string | string[]>;
  Parts?: { Headers?: Record<string, string>; ContentRef?: string }[];
  "Text-part"?: string;
  "Html-part"?: string;
  SpamAssassinScore?: string;
  [attachment: `Attachment${number}`]: string | undefined;
}

// Headers the composer writes itself from the fields.
const COMPOSED_HEADERS = new Set([
  "from", "to", "cc", "bcc", "reply-to", "subject", "date", "message-id", "mime-version",
  "content-type", "content-transfer-encoding",
]);

const parameter = (value: string | undefined, name: string) =>
  value?.match(new RegExp(`${name}\\*?=\\s*"?([^";]+)"?`, "i"))?.[1]?.trim();

// Mailjet has no raw message, so it's rebuilt from the original headers, the text and
// HTML parts and the attachments, which come base64 in Attachment1, Attachment2…
export async function mailjetInboundRaw(payload: MailjetInbound): Promise<Uint8Array> {
  const headers = Object.entries(payload.Headers ?? {});
  const header = (name: string) => {
    const value = headers.find(([key]) => key.toLowerCase() === name)?.[1];
    return Array.isArray(value) ? value[0] : value;
  };
  const attachments = (payload.Parts ?? [])
    .filter((part) => part.ContentRef?.startsWith("Attachment") && payload[part.ContentRef as `Attachment${number}`])
    .map((part) => {
      const partHeaders = Object.fromEntries(Object.entries(part.Headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
      const contentType = partHeaders["content-type"]?.split(";")[0]?.trim() || "application/octet-stream";
      return {
        filename: parameter(partHeaders["content-disposition"], "filename") ?? parameter(partHeaders["content-type"], "name") ?? "attachment",
        contentType,
        content: Buffer.from(payload[part.ContentRef as `Attachment${number}`]!, "base64"),
        cid: partHeaders["content-id"]?.replace(/^<|>$/g, "") || undefined,
      };
    });
  const date = header("date") ? new Date(header("date")!) : undefined;
  const composer = new MailComposer({
    from: header("from") ?? payload.From ?? payload.Sender,
    to: header("to") ?? payload.Recipient,
    cc: header("cc"),
    replyTo: header("reply-to"),
    subject: header("subject") ?? payload.Subject ?? "",
    date: date && !Number.isNaN(date.getTime()) ? date : undefined,
    messageId: header("message-id"),
    text: payload["Text-part"] || undefined,
    html: payload["Html-part"] || undefined,
    headers: headers.flatMap(([key, value]) =>
      COMPOSED_HEADERS.has(key.toLowerCase()) ? [] : (Array.isArray(value) ? value : [value]).map((entry) => ({ key, value: entry })),
    ),
    attachments,
  });
  const built = await new Promise<Buffer>((resolve, reject) =>
    composer.compile().build((error, output) => (error ? reject(error) : resolve(output))),
  );
  return new Uint8Array(built);
}

// The envelope recipient: the address the mail was delivered to, Bcc included.
export function mailjetInboundHint(payload: MailjetInbound): InboundHint {
  const recipient = payload.Recipient?.trim().toLowerCase();
  return { recipients: recipient ? [recipient] : [] };
}

// The provider

export interface MailjetTarget {
  workspaceId: string;
  connectionId: string;
  apiKey: string;
  secretKey: string;
  // Receiving domains, each with the id of our parse route for it.
  inbound: Record<string, string>;
}

export class MailjetProvider implements MailProvider {
  readonly kind = "mailjet" as const;
  // The Parse API pushes the only copy, so there's nothing to backfill from.
  readonly capabilities = { receiving: true, backfill: false, refreshDomains: true };
  readonly api: MailjetApi;
  private readonly stored: StoredInbound;

  constructor(
    readonly target: MailjetTarget,
    fetcher: Fetch = fetch,
  ) {
    this.api = new MailjetApi(target.apiKey, target.secretKey, fetcher);
    this.stored = new StoredInbound(target.workspaceId, target.connectionId);
  }

  async allDns(): Promise<MailjetDns[]> {
    const all: MailjetDns[] = [];
    for (let offset = 0; offset < 10_000; offset += 1000) {
      const { Data } = await this.api.call<{ Data?: MailjetDns[] }>("GET", `/v3/REST/dns?Limit=1000&Offset=${offset}`);
      all.push(...(Data ?? []));
      if ((Data ?? []).length < 1000) break;
    }
    return all;
  }

  async listDomains(): Promise<ProviderDomain[]> {
    return (await this.allDns()).map((dns) => {
      const name = dns.Domain.toLowerCase();
      const ready = dns.DKIMStatus === "OK";
      return { id: String(dns.ID), name, status: ready ? "verified" : "pending", sending: ready, receiving: name in this.target.inbound };
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
    try {
      await this.api.call("POST", "/v3.1/send", { Messages: [mailjetMessage(message, attachments)] });
    } catch (error) {
      // Should Mailjet refuse our Message-ID or threading headers, the email still goes
      // out without them.
      const threaded = THREADING.some((name) => message.headers?.[name]);
      if (!(threaded && error instanceof MailjetError && error.status === 400 && /header/i.test(error.message))) throw error;
      await this.api.call("POST", "/v3.1/send", { Messages: [mailjetMessage(message, attachments, { threading: false })] });
    }
    return { id: mailjetCustomId(message) };
  }

  async fetchInbound(id: string, hint?: InboundHint): Promise<InboundEmail> {
    const email = await this.stored.read(id, hint);
    if (!email) throw new Error(`Mailjet email ${id} isn't in storage`);
    return email;
  }

  async afterIngest(id: string) {
    await this.stored.remove(id);
  }

  // Domains

  async dns(name: string) {
    const { Data } = await this.api.call<{ Data?: MailjetDns[] }>("GET", `/v3/REST/dns/${encodeURIComponent(name)}`);
    const dns = Data?.[0];
    if (!dns) throw new Error(`${name} isn't in this Mailjet account`);
    return dns;
  }

  // A catch-all sender for the domain, which makes Mailjet create its DNS entry.
  async addDomain(name: string) {
    const existing = (await this.allDns()).find((dns) => dns.Domain.toLowerCase() === name);
    if (!existing) await this.api.call("POST", "/v3/REST/sender", { Email: `*@${name}` });
    return this.domainRecords(name);
  }

  async domainRecords(name: string): Promise<DnsRecord[]> {
    let dns = await this.dns(name);
    // Asking Mailjet to check again, and to validate the catch-all sender by its TXT
    // record, saves people a trip to its dashboard.
    if (dns.DKIMStatus !== "OK" || dns.SPFStatus !== "OK") {
      await this.api.call("POST", `/v3/REST/dns/${encodeURIComponent(name)}/check`, {}).catch(() => undefined);
      dns = await this.dns(name);
    }
    await this.validateSender(name).catch(() => undefined);
    return mailjetDomainRecords(dns, { receiving: name in this.target.inbound, needsDmarc: !(await hasDmarcPolicy(name)) });
  }

  private async validateSender(name: string) {
    const { Data } = await this.api.call<{ Data?: MailjetSender[] }>("GET", `/v3/REST/sender?Email=${encodeURIComponent(`*@${name}`)}`);
    const sender = Data?.find((item) => item.Email.toLowerCase() === `*@${name}`);
    if (sender && sender.Status !== "Active") await this.api.call("POST", `/v3/REST/sender/${sender.ID}/validate`, {});
  }

  // Receiving: a parse route catching the domain's mail and posting it to us.
  async createRoute(domain: string, url: string) {
    const { Data } = await this.api.call<{ Data?: { ID: number | string }[] }>("POST", "/v3/REST/parseroute", { Url: url, Email: `*@${domain}` });
    const id = Data?.[0]?.ID;
    if (id === undefined) throw new MailjetError("Mailjet didn't create the parse route", 502);
    return String(id);
  }

  async deleteRoute(id: string) {
    try {
      await this.api.call("DELETE", `/v3/REST/parseroute/${encodeURIComponent(id)}`);
    } catch (error) {
      if (!(error instanceof MailjetError && error.status === 404)) throw error;
    }
  }

  // Delivery events: one callback address per event type, grouped (Version 2). Mailjet
  // takes one per type, so a type the customer already uses is skipped.
  async createEventCallbacks(url: string) {
    const created: string[] = [];
    let complete = true;
    for (const type of MAILJET_EVENTS) {
      try {
        const { Data } = await this.api.call<{ Data?: { ID: number | string }[] }>("POST", "/v3/REST/eventcallbackurl", {
          EventType: type,
          Url: url,
          Version: 2,
          Status: "alive",
          IsBackup: false,
        });
        if (Data?.[0]?.ID !== undefined) created.push(String(Data[0].ID));
      } catch (error) {
        if (!(error instanceof MailjetError && error.status === 400)) throw error;
        complete = false;
      }
    }
    return { ids: created, complete };
  }

  async deleteEventCallback(id: string) {
    try {
      await this.api.call("DELETE", `/v3/REST/eventcallbackurl/${encodeURIComponent(id)}`);
    } catch (error) {
      if (!(error instanceof MailjetError && error.status === 404)) throw error;
    }
  }

  async disconnect(callbackIds: string[]) {
    for (const id of Object.values(this.target.inbound)) await this.deleteRoute(id);
    for (const id of callbackIds) await this.deleteEventCallback(id);
  }
}
