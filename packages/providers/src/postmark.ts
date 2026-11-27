import { timingSafeEqual } from "node:crypto";
import { readObject } from "@hellobox/storage";
import MailComposer from "nodemailer/lib/mail-composer";
import { dmarcRecord, hasDmarcPolicy } from "./dns";
import { StoredInbound } from "./pushed";
import type { DnsRecord, InboundEmail, InboundHint, MailProvider, OutgoingMessage, ProviderDomain } from "./types";

const API = "https://api.postmarkapp.com";
export const POSTMARK_INBOUND_MX = "inbound.postmarkapp.com";
export const POSTMARK_RETURN_PATH = "pm.mtasv.net";
// The user name in the basic-auth credentials Postmark sends to our webhooks.
export const POSTMARK_WEBHOOK_USER = "hellobox";
const STREAM = "outbound";

// Postmark answers errors with a numeric ErrorCode next to the HTTP status.
export class PostmarkError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number | null,
  ) {
    super(message);
    this.name = "PostmarkError";
  }
}

// The token was revoked, or never worked. The connection needs reconnecting.
export const isPostmarkAuthError = (error: unknown) => error instanceof PostmarkError && error.status === 401;

// Postmark only takes an inbound domain once its MX already points at Postmark.
export const isPostmarkMissingMx = (error: unknown) =>
  error instanceof PostmarkError && error.status !== 401 && /\bMX\b/i.test(error.message);

type Fetch = typeof fetch;

async function request<T>(fetcher: Fetch, header: string, token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetcher(`${API}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      [header]: token,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    const code = typeof json.ErrorCode === "number" ? json.ErrorCode : null;
    const message = typeof json.Message === "string" ? json.Message : `Postmark answered ${res.status}`;
    throw new PostmarkError(message, res.status, code);
  }
  return json as T;
}

export interface PostmarkServer {
  ID: number;
  Name: string;
  ApiTokens: string[];
  InboundDomain: string;
  InboundHookUrl: string;
  RawEmailEnabled: boolean;
}

export interface PostmarkDomainSummary {
  ID: number;
  Name: string;
  DKIMVerified: boolean;
  ReturnPathDomainVerified: boolean;
}

export interface PostmarkDomainDetails extends PostmarkDomainSummary {
  DKIMHost: string;
  DKIMTextValue: string;
  DKIMPendingHost: string;
  DKIMPendingTextValue: string;
  ReturnPathDomain: string;
  ReturnPathDomainCNAMEValue: string;
}

interface PostmarkWebhook {
  ID: number;
  Url: string;
}

// Account-level calls: servers and domains. Only owners and admins have this token.
export class PostmarkAccount {
  constructor(
    private readonly token: string,
    private readonly fetcher: Fetch = fetch,
  ) {}

  private call<T>(method: string, path: string, body?: unknown) {
    return request<T>(this.fetcher, "X-Postmark-Account-Token", this.token, method, path, body);
  }

  async listServers() {
    const servers: PostmarkServer[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await this.call<{ TotalCount: number; Servers: PostmarkServer[] }>("GET", `/servers?count=500&offset=${offset}`);
      servers.push(...page.Servers);
      if (servers.length >= page.TotalCount || !page.Servers.length) return servers;
    }
  }

  getServer(id: number) {
    return this.call<PostmarkServer>("GET", `/servers/${id}`);
  }

  createServer(name: string) {
    return this.call<PostmarkServer>("POST", "/servers", { Name: name, Color: "Blue", DeliveryType: "Live" });
  }

  editServer(id: number, patch: Partial<Pick<PostmarkServer, "InboundDomain" | "InboundHookUrl" | "RawEmailEnabled">>) {
    return this.call<PostmarkServer>("PUT", `/servers/${id}`, patch);
  }

  async listDomains() {
    const domains: PostmarkDomainSummary[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await this.call<{ TotalCount: number; Domains: PostmarkDomainSummary[] }>("GET", `/domains?count=500&offset=${offset}`);
      domains.push(...page.Domains);
      if (domains.length >= page.TotalCount || !page.Domains.length) return domains;
    }
  }

  getDomain(id: number) {
    return this.call<PostmarkDomainDetails>("GET", `/domains/${id}`);
  }

  createDomain(name: string) {
    return this.call<PostmarkDomainDetails>("POST", "/domains", { Name: name, ReturnPathDomain: `pm-bounces.${name}` });
  }

  verifyDkim(id: number) {
    return this.call<PostmarkDomainDetails>("PUT", `/domains/${id}/verifyDkim`);
  }

  verifyReturnPath(id: number) {
    return this.call<PostmarkDomainDetails>("PUT", `/domains/${id}/verifyReturnPath`);
  }
}

// Server-level calls: sending, webhooks and inbound messages for one server.
export class PostmarkServerApi {
  constructor(
    private readonly token: string,
    private readonly fetcher: Fetch = fetch,
  ) {}

  call<T>(method: string, path: string, body?: unknown) {
    return request<T>(this.fetcher, "X-Postmark-Server-Token", this.token, method, path, body);
  }

  async listWebhooks() {
    const { Webhooks } = await this.call<{ Webhooks: PostmarkWebhook[] }>("GET", `/webhooks?MessageStream=${STREAM}`);
    return Webhooks;
  }

  // Delivery, bounce and complaint events, with basic auth. Safe to run again: an
  // existing webhook for the URL is updated instead.
  async ensureEventsWebhook(url: string, password: string) {
    const body = {
      Url: url,
      MessageStream: STREAM,
      HttpAuth: { Username: POSTMARK_WEBHOOK_USER, Password: password },
      Triggers: {
        Delivery: { Enabled: true },
        Bounce: { Enabled: true, IncludeContent: false },
        SpamComplaint: { Enabled: true, IncludeContent: false },
        Open: { Enabled: false },
        Click: { Enabled: false },
        SubscriptionChange: { Enabled: false },
      },
    };
    const existing = (await this.listWebhooks()).find((webhook) => webhook.Url === url);
    const saved = existing
      ? await this.call<PostmarkWebhook>("PUT", `/webhooks/${existing.ID}`, body)
      : await this.call<PostmarkWebhook>("POST", "/webhooks", body);
    return saved.ID;
  }

  deleteWebhook(id: number) {
    return this.call("DELETE", `/webhooks/${id}`);
  }

  async failedInbound() {
    const { InboundMessages } = await this.call<{ InboundMessages: { MessageID: string }[] }>(
      "GET",
      "/messages/inbound?count=100&offset=0&status=failed",
    );
    return InboundMessages.map((message) => message.MessageID);
  }

  retryInbound(messageId: string) {
    return this.call("PUT", `/messages/inbound/${encodeURIComponent(messageId)}/retry`);
  }
}

// Webhooks

// Postmark has no signatures. Our webhooks take basic auth with a password we made,
// compared in constant time.
export function checkBasicAuth(header: string | null, password: string) {
  if (!header?.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const expected = Buffer.from(`${POSTMARK_WEBHOOK_USER}:${password}`);
  const given = Buffer.from(decoded);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// The inbound hook only takes credentials inside its URL.
export function withBasicAuth(url: string, password: string) {
  const parsed = new URL(url);
  parsed.username = POSTMARK_WEBHOOK_USER;
  parsed.password = password;
  return parsed.toString();
}

interface PostmarkAddress {
  Email: string;
  Name?: string;
}

export interface PostmarkInbound {
  MessageID: string;
  From?: string;
  FromFull?: PostmarkAddress;
  ToFull?: PostmarkAddress[];
  CcFull?: PostmarkAddress[];
  BccFull?: PostmarkAddress[];
  OriginalRecipient?: string;
  ReplyTo?: string;
  Subject?: string;
  Date?: string;
  TextBody?: string;
  HtmlBody?: string;
  Headers?: { Name: string; Value: string }[];
  Attachments?: { Name: string; Content: string; ContentType: string; ContentID?: string; ContentLength?: number }[];
  // Only when RawEmailEnabled is on, which we turn on when connecting.
  RawEmail?: string;
}

const formatAddress = (address: PostmarkAddress) =>
  address.Name ? `"${address.Name.replace(/["\\]/g, "")}" <${address.Email}>` : address.Email;

// Headers the composer writes itself from the fields above.
const COMPOSED_HEADERS = new Set([
  "from", "to", "cc", "bcc", "reply-to", "subject", "date", "message-id", "mime-version",
  "content-type", "content-transfer-encoding",
]);

// The raw message. RawEmail is the original, byte for byte. Without it, the message is
// rebuilt from the parsed fields and headers, which keeps threading and attachments.
export async function postmarkInboundRaw(payload: PostmarkInbound): Promise<Uint8Array> {
  if (payload.RawEmail) return new TextEncoder().encode(payload.RawEmail);
  const headers = payload.Headers ?? [];
  const header = (name: string) => headers.find((entry) => entry.Name.toLowerCase() === name)?.Value;
  const composer = new MailComposer({
    from: payload.FromFull ? formatAddress(payload.FromFull) : payload.From,
    to: (payload.ToFull ?? []).map(formatAddress),
    cc: (payload.CcFull ?? []).map(formatAddress),
    replyTo: payload.ReplyTo || undefined,
    subject: payload.Subject ?? "",
    date: payload.Date ? new Date(payload.Date) : undefined,
    messageId: header("message-id"),
    text: payload.TextBody || undefined,
    html: payload.HtmlBody || undefined,
    headers: headers
      .filter((entry) => !COMPOSED_HEADERS.has(entry.Name.toLowerCase()))
      .map((entry) => ({ key: entry.Name, value: entry.Value })),
    attachments: (payload.Attachments ?? []).map((attachment) => ({
      filename: attachment.Name,
      contentType: attachment.ContentType,
      content: Buffer.from(attachment.Content, "base64"),
      cid: attachment.ContentID?.replace(/^<|>$/g, "") || undefined,
    })),
  });
  const built = await new Promise<Buffer>((resolve, reject) =>
    composer.compile().build((error, output) => (error ? reject(error) : resolve(output))),
  );
  return new Uint8Array(built);
}

// Who the email was delivered to, including Bcc and forwarded mail.
export function postmarkInboundHint(payload: PostmarkInbound): InboundHint {
  const recipients = [
    payload.OriginalRecipient,
    ...[...(payload.ToFull ?? []), ...(payload.CcFull ?? []), ...(payload.BccFull ?? [])].map((address) => address.Email),
  ].filter((value): value is string => Boolean(value));
  return { recipients: [...new Set(recipients.map((value) => value.toLowerCase()))] };
}

export interface PostmarkEvent {
  RecordType?: string;
  Type?: string;
  MessageID?: string;
  ID?: number;
  Metadata?: Record<string, string>;
  // The recipient a bounce or complaint is about, and Delivery's.
  Email?: string;
  Recipient?: string;
  Description?: string;
  Details?: string;
}

// Who a Postmark event is about, and what the receiving server said.
export function postmarkEventDetail(event: PostmarkEvent): { recipients: string[]; reason?: string } {
  const recipient = (event.Email ?? event.Recipient)?.trim().toLowerCase();
  const reason = event.RecordType === "Delivery" ? undefined : event.Details || event.Description || undefined;
  return { recipients: recipient ? [recipient] : [], reason };
}

// Postmark events, mapped onto the delivery statuses the inbox already shows.
export function postmarkDeliveryType(event: PostmarkEvent) {
  switch (event.RecordType) {
    case "Delivery":
      return "email.delivered";
    case "SpamComplaint":
      return "email.complained";
    case "Bounce":
      return ["HardBounce", "BadEmailAddress", "ManuallyDeactivated", "Blocked", "SpamNotification"].includes(event.Type ?? "")
        ? "email.bounced"
        : ["Transient", "SoftBounce", "DnsError"].includes(event.Type ?? "")
          ? "email.delivery_delayed"
          : null;
    default:
      return null;
  }
}

// The provider

export interface PostmarkTarget {
  workspaceId: string;
  connectionId: string;
  accountToken: string;
  serverToken: string;
  serverId: number;
  inboundDomain?: string;
  // Receiving was turned on for this domain, and Postmark hasn't seen its MX yet.
  pendingInboundDomain?: string;
}

const bareAddress = (value: string) => (value.match(/<([^>]+)>/)?.[1] ?? value).trim();

export class PostmarkProvider implements MailProvider {
  readonly kind = "postmark" as const;
  // Inbound mail waits in our storage until it's ingested, and domains verify in the
  // background after DNS changes.
  readonly capabilities = { receiving: true, backfill: true, refreshDomains: true };
  readonly account: PostmarkAccount;
  readonly server: PostmarkServerApi;
  private readonly stored: StoredInbound;

  constructor(
    readonly target: PostmarkTarget,
    fetcher: Fetch = fetch,
  ) {
    this.account = new PostmarkAccount(target.accountToken, fetcher);
    this.server = new PostmarkServerApi(target.serverToken, fetcher);
    this.stored = new StoredInbound(target.workspaceId, target.connectionId);
  }

  // Domains belong to the account, so every server can send from them. Receiving is the
  // server's one inbound domain.
  async listDomains(): Promise<ProviderDomain[]> {
    const domains = await this.account.listDomains();
    return domains.map((domain) => {
      const name = domain.Name.toLowerCase();
      return {
        id: String(domain.ID),
        name,
        status: domain.DKIMVerified ? "verified" : "pending",
        sending: domain.DKIMVerified,
        receiving: name === this.target.inboundDomain,
      };
    });
  }

  async send(message: OutgoingMessage) {
    const attachments = await Promise.all(
      (message.attachments ?? []).map(async (file) => ({
        Name: file.filename,
        ContentType: file.contentType,
        Content: Buffer.from(await new Response(await readObject(file.storageKey)).arrayBuffer()).toString("base64"),
        ...(file.contentId ? { ContentID: `cid:${file.contentId}` } : {}),
      })),
    );
    const { MessageID } = await this.server.call<{ MessageID: string }>("POST", "/email", {
      From: message.from,
      To: message.to.join(", "),
      Cc: message.cc?.length ? message.cc.join(", ") : undefined,
      Bcc: message.bcc?.length ? message.bcc.join(", ") : undefined,
      ReplyTo: message.replyTo?.length ? message.replyTo.map(bareAddress).join(", ") : undefined,
      Subject: message.subject,
      HtmlBody: message.html || undefined,
      TextBody: message.text ?? (message.html ? undefined : " "),
      Headers: Object.entries(message.headers ?? {}).map(([Name, Value]) => ({ Name, Value })),
      Attachments: attachments.length ? attachments : undefined,
      Metadata: message.tags,
      MessageStream: STREAM,
    });
    return { id: MessageID };
  }

  async fetchInbound(id: string, hint?: InboundHint): Promise<InboundEmail> {
    const email = await this.stored.read(id, hint);
    if (!email) throw new Error(`Postmark email ${id} isn't in storage`);
    return email;
  }

  listInbound(next?: string) {
    return this.stored.list(next);
  }

  async afterIngest(id: string) {
    await this.stored.remove(id);
  }

  // Mail that failed every webhook attempt waits in Postmark for 45 days. Asking for it
  // again sends it back through the webhook.
  async retryFailedInbound() {
    const failed = await this.server.failedInbound();
    for (const id of failed) await this.server.retryInbound(id);
    return failed.length;
  }

  // Domains

  private async findDomain(name: string) {
    const summary = (await this.account.listDomains()).find((domain) => domain.Name.toLowerCase() === name);
    if (!summary) throw new Error(`${name} isn't in this Postmark account`);
    return this.account.getDomain(summary.ID);
  }

  async addDomain(name: string) {
    try {
      await this.account.createDomain(name);
    } catch (error) {
      // 512: the domain is already in the account.
      if (!(error instanceof PostmarkError && error.code === 512)) throw error;
    }
    return this.domainRecords(name);
  }

  async domainRecords(name: string): Promise<DnsRecord[]> {
    const domain = await this.findDomain(name);
    // Asking Postmark to check again is free, and saves people a trip to its dashboard.
    if (!domain.DKIMVerified) await this.account.verifyDkim(domain.ID).catch(() => undefined);
    if (!domain.ReturnPathDomainVerified && domain.ReturnPathDomain) {
      await this.account.verifyReturnPath(domain.ID).catch(() => undefined);
    }
    return postmarkDomainRecords(domain, {
      receiving: name === this.target.inboundDomain || name === this.target.pendingInboundDomain,
      needsDmarc: !(await hasDmarcPolicy(name)),
    });
  }

  // Receiving

  // A server has one inbound domain. Setting another moves receiving over to it.
  async setInboundDomain(domain: string | null, hookUrl: string) {
    await this.account.editServer(this.target.serverId, {
      InboundDomain: domain ?? "",
      InboundHookUrl: hookUrl,
      RawEmailEnabled: true,
    });
    this.target.inboundDomain = domain ?? undefined;
  }

  // Stops inbound and removes our event webhook. The server and its domains stay.
  async disconnect(eventsWebhookId: number | null) {
    await this.account.editServer(this.target.serverId, { InboundDomain: "", InboundHookUrl: "" });
    if (eventsWebhookId) await this.server.deleteWebhook(eventsWebhookId);
  }
}

// DKIM while pending, the live one after; the Return-Path; DMARC; and the MX when the
// domain receives.
export function postmarkDomainRecords(
  domain: PostmarkDomainDetails,
  options: { receiving: boolean; needsDmarc: boolean },
): DnsRecord[] {
  const name = domain.Name.toLowerCase();
  const records: DnsRecord[] = [];
  const dkimHost = domain.DKIMPendingHost || domain.DKIMHost;
  const dkimValue = domain.DKIMPendingTextValue || domain.DKIMTextValue;
  if (dkimHost && dkimValue) {
    records.push({
      type: "TXT",
      name: dkimHost.toLowerCase(),
      value: dkimValue,
      purpose: "Signs your mail with DKIM and verifies the domain",
    });
  }
  if (domain.ReturnPathDomain) {
    records.push({
      type: "CNAME",
      name: domain.ReturnPathDomain.toLowerCase(),
      value: domain.ReturnPathDomainCNAMEValue || POSTMARK_RETURN_PATH,
      purpose: "Receives bounces, so SPF passes for your domain",
    });
  }
  if (options.needsDmarc) records.push(dmarcRecord(name));
  if (options.receiving) records.push(postmarkInboundMx(name));
  return records;
}

export const postmarkInboundMx = (domain: string): DnsRecord => ({
  type: "MX",
  name: domain,
  value: POSTMARK_INBOUND_MX,
  priority: 10,
  purpose: "Delivers mail for this domain to Postmark",
  keepExisting: true,
});
