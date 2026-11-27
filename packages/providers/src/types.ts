export type ProviderKind =
  | "resend"
  | "ses"
  | "postmark"
  | "mailgun"
  | "demo"
  | "smtp"
  | "sendgrid"
  | "brevo"
  | "mailersend"
  | "mailjet"
  | "bird"
  | "custom";

export const PROVIDER_INFO: Record<ProviderKind, {
  name: string;
  // HelloBox turns receiving on and off from settings. Resend's is set in its dashboard.
  receivingInHelloBox: boolean;
  // The provider can receive mail for us. Without it, a connection only sends, and its
  // domains receive with HelloBox.
  receives: boolean;
}> = {
  ses: { name: "Amazon SES", receivingInHelloBox: true, receives: true },
  resend: { name: "Resend", receivingInHelloBox: false, receives: true },
  postmark: { name: "Postmark", receivingInHelloBox: true, receives: true },
  mailgun: { name: "Mailgun", receivingInHelloBox: true, receives: true },
  // The public demo sandbox. Never offered as a choice.
  demo: { name: "HelloBox demo", receivingInHelloBox: false, receives: true },
  // Not built yet: plans/PROVIDERS.md. Each says whether it will receive.
  smtp: { name: "SMTP", receivingInHelloBox: true, receives: false },
  sendgrid: { name: "SendGrid", receivingInHelloBox: true, receives: true },
  brevo: { name: "Brevo", receivingInHelloBox: true, receives: true },
  mailersend: { name: "MailerSend", receivingInHelloBox: true, receives: true },
  mailjet: { name: "Mailjet", receivingInHelloBox: true, receives: true },
  bird: { name: "Bird", receivingInHelloBox: true, receives: true },
  custom: { name: "Custom provider", receivingInHelloBox: true, receives: false },
};

export interface ProviderDomain {
  id: string;
  name: string;
  status: string;
  sending: boolean;
  receiving: boolean;
}

export interface DnsRecord {
  type: "CNAME" | "MX" | "TXT";
  name: string;
  value: string;
  priority?: number;
  // What the record is for, shown next to it.
  purpose: string;
  // Leave a record of this kind alone if the domain already has a different one, like
  // an MX that points somewhere else or a DMARC policy.
  keepExisting?: boolean;
}

export interface Authentication {
  spf?: string;
  dkim?: string;
  dmarc?: string;
}

export interface OutgoingAttachment {
  filename: string;
  contentType: string;
  storageKey: string;
  contentId?: string;
}

export interface OutgoingMessage {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string[];
  subject: string;
  html: string;
  text?: string;
  headers?: Record<string, string>;
  attachments?: OutgoingAttachment[];
  // Labels the provider keeps on the message and echoes back in delivery events.
  tags?: Record<string, string>;
}

export interface SentMessage {
  id: string;
  // Set when the provider writes its own Message-ID over ours, so replies thread.
  messageIdHeader?: string;
}

export interface InboundAttachment {
  id: string;
  filename: string;
  contentType: string;
  contentId: string | null;
  disposition: string | null;
  open(): Promise<ReadableStream<Uint8Array>>;
}

// One received email, the same shape whichever provider it came from. Addresses keep
// their display names ("Ada <ada@example.com>") and are parsed by the ingest code.
export interface InboundEmail {
  id: string;
  from: string;
  to: string[];
  cc: string[];
  replyTo: string[];
  // Envelope recipients, which include Bcc and forwarded mail.
  recipients: string[];
  subject: string;
  text: string | null;
  html: string | null;
  headers: Record<string, string | string[]>;
  messageId: string | null;
  sentAt: Date;
  authentication: Authentication | null;
  raw: { open(): Promise<ReadableStream<Uint8Array>> } | null;
  attachments: InboundAttachment[];
}

// What a webhook already told us about an inbound email, passed on to ingest.
export interface InboundHint {
  recipients?: string[];
  authentication?: Authentication;
}

export interface InboundPage {
  ids: string[];
  // Pass back to get the next page. Missing on the last one.
  next?: string;
}

// What the maintenance job may do for a connection.
export interface ProviderCapabilities {
  // The provider receives mail and fetchInbound reads it. False for a connection that only
  // sends: its domains receive with HelloBox, whose mail ingest reads from our storage.
  receiving: boolean;
  // listInbound can find mail a webhook missed.
  backfill: boolean;
  // Domains change status in the background, so they're synced on a schedule.
  refreshDomains: boolean;
}

export interface MailProvider {
  readonly kind: ProviderKind;
  readonly capabilities: ProviderCapabilities;
  listDomains(): Promise<ProviderDomain[]>;
  send(message: OutgoingMessage, idempotencyKey: string): Promise<SentMessage>;
  // Both left out by a provider that doesn't receive.
  fetchInbound?(id: string, hint?: InboundHint): Promise<InboundEmail>;
  // Newest first. Backfill walks pages until it finds only mail it already has.
  listInbound?(next?: string): Promise<InboundPage>;
  // Runs once an email is safely stored, for providers that hold a copy for us.
  afterIngest?(id: string): Promise<void>;
  // Asks the provider to send mail again that failed every webhook attempt. Returns how
  // many it asked for.
  retryFailedInbound?(): Promise<number>;
}
