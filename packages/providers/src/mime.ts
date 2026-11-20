import MailComposer from "nodemailer/lib/mail-composer";
import PostalMime, { type Email, type Header } from "postal-mime";
import type { Authentication, InboundEmail, OutgoingMessage } from "./types";

type Address = NonNullable<Email["from"]>;

function formatMailbox(mailbox: { name: string; address: string }) {
  const name = mailbox.name.replace(/["\\]/g, "").trim();
  return name ? `"${name}" <${mailbox.address}>` : mailbox.address;
}

// Groups ("team: a@x, b@x;") are flattened into their members.
function formatAddresses(list: Address[] | Address | undefined) {
  if (!list) return [];
  return (Array.isArray(list) ? list : [list]).flatMap((entry) =>
    entry.group ? entry.group.map(formatMailbox) : entry.address ? [formatMailbox(entry)] : [],
  );
}

function headerMap(headers: Header[]) {
  const map: Record<string, string | string[]> = {};
  for (const { key, value } of headers) {
    const existing = map[key];
    if (existing === undefined) map[key] = value;
    else map[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
  }
  return map;
}

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

// Reads spf=, dkim= and dmarc= results from an Authentication-Results header, trusting
// only the one our receiving server added on top.
export function parseAuthenticationResults(value: string | undefined): Authentication | null {
  if (!value) return null;
  const result: Authentication = {};
  for (const method of ["spf", "dkim", "dmarc"] as const) {
    const match = value.match(new RegExp(`\\b${method}=([a-z]+)`, "i"));
    if (match?.[1]) result[method] = match[1].toLowerCase();
  }
  return Object.keys(result).length ? result : null;
}

const toBytes = (content: ArrayBuffer | Uint8Array | string) =>
  typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content);

const streamOf = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

export async function parseRawEmail(
  id: string,
  raw: Uint8Array,
  envelope: { recipients?: string[]; authentication?: Authentication } = {},
): Promise<InboundEmail> {
  const parsed = await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" });
  const headers = headerMap(parsed.headers);
  const date = parsed.date ? new Date(parsed.date) : new Date();
  return {
    id,
    from: formatAddresses(parsed.from)[0] ?? "",
    to: formatAddresses(parsed.to),
    cc: formatAddresses(parsed.cc),
    replyTo: formatAddresses(parsed.replyTo),
    recipients: envelope.recipients ?? [],
    subject: parsed.subject ?? "",
    text: parsed.text ?? null,
    html: parsed.html ?? null,
    headers,
    messageId: parsed.messageId ?? null,
    sentAt: Number.isNaN(date.getTime()) ? new Date() : date,
    authentication:
      envelope.authentication ?? parseAuthenticationResults(first(headers["authentication-results"])),
    raw: { open: async () => streamOf(raw) },
    attachments: parsed.attachments.map((attachment, index) => {
      const bytes = toBytes(attachment.content);
      return {
        id: `part-${index + 1}`,
        filename: attachment.filename || "attachment",
        contentType: attachment.mimeType || "application/octet-stream",
        contentId: attachment.contentId?.replace(/^<|>$/g, "") ?? null,
        disposition: attachment.disposition,
        open: async () => streamOf(bytes),
      };
    }),
  };
}

export interface ComposedAttachment {
  filename: string;
  contentType: string;
  content: Uint8Array;
  contentId?: string;
}

// Builds the raw message for providers that send MIME. Bcc stays out of the headers,
// so the caller passes every recipient to the provider separately.
export async function buildRawEmail(
  message: OutgoingMessage,
  attachments: ComposedAttachment[],
): Promise<Uint8Array> {
  const headers = { ...message.headers };
  const messageId = headers["Message-ID"];
  delete headers["Message-ID"];
  const composer = new MailComposer({
    from: message.from,
    to: message.to,
    cc: message.cc,
    replyTo: message.replyTo,
    subject: message.subject,
    html: message.html || undefined,
    text: message.text ?? (message.html ? undefined : ""),
    headers,
    messageId,
    attachments: attachments.map((attachment) => ({
      filename: attachment.filename,
      contentType: attachment.contentType,
      content: Buffer.from(attachment.content),
      cid: attachment.contentId,
    })),
  });
  const built = await new Promise<Buffer>((resolve, reject) =>
    composer.compile().build((error, output) => (error ? reject(error) : resolve(output))),
  );
  return new Uint8Array(built);
}
