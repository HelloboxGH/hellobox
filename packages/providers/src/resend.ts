import type { ReceivedEmail, ResendClient, ResendDomainRecord } from "@hellobox/resend";
import { signedSendUrl } from "@hellobox/storage";
import { dmarcRecord } from "./dns";
import type { DnsRecord, InboundEmail, MailProvider, OutgoingMessage } from "./types";

async function download(url: string) {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Download from Resend failed with status ${res.status}`);
  }
  return res.body;
}

function header(email: ReceivedEmail, name: string) {
  const value = email.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

// Resend sends through Amazon SES, which writes its own Message-ID over ours, and Resend
// never says what it was. References survives, and mail clients copy it into every reply,
// so ours goes there too: a reply then names an id we stored.
export function resendHeaders(headers: Record<string, string> | undefined) {
  const own = headers?.["Message-ID"];
  if (!headers || !own) return headers;
  const references = headers.References?.split(/\s+/).filter(Boolean) ?? [];
  return references.includes(own) ? headers : { ...headers, References: [...references, own].join(" ") };
}

export class ResendProvider implements MailProvider {
  readonly kind = "resend" as const;
  // Resend tells us about domain changes through its dashboard flow.
  readonly capabilities = { receiving: true, backfill: true, refreshDomains: false };

  constructor(readonly client: ResendClient) {}

  async listDomains() {
    const domains = await this.client.listDomains();
    return domains.map((domain) => ({
      id: domain.id,
      name: domain.name.toLowerCase(),
      status: domain.status,
      sending: domain.capabilities?.sending === "enabled",
      receiving: domain.capabilities?.receiving === "enabled",
    }));
  }

  async send(message: OutgoingMessage, idempotencyKey: string) {
    const attachments = await Promise.all(
      (message.attachments ?? []).map(async (file) => ({
        filename: file.filename,
        path: await signedSendUrl(file.storageKey),
        content_id: file.contentId,
      })),
    );
    const { id } = await this.client.sendEmail(
      {
        from: message.from,
        to: message.to,
        cc: message.cc,
        bcc: message.bcc,
        reply_to: message.replyTo,
        subject: message.subject,
        // Resend needs a body, but an email with only attachments has none to give.
        ...(message.html.trim() ? { html: message.html } : { text: message.text?.trim() ? message.text : " " }),
        headers: resendHeaders(message.headers),
        attachments: attachments.length ? attachments : undefined,
      },
      idempotencyKey,
    );
    return { id };
  }

  async fetchInbound(id: string): Promise<InboundEmail> {
    const email = await this.client.getReceived(id);
    const attachments = email.attachments?.length ? await this.client.listAttachments(id) : [];
    return {
      id,
      from: header(email, "from") ?? email.from,
      to: email.to ?? [],
      cc: email.cc ?? [],
      replyTo: email.reply_to ?? [],
      recipients: email.received_for ?? [],
      subject: email.subject ?? "",
      text: email.text,
      html: email.html,
      headers: email.headers ?? {},
      messageId: email.message_id,
      sentAt: new Date(email.created_at),
      authentication: email.authentication ?? null,
      raw: email.raw?.download_url
        ? { open: () => download(email.raw!.download_url) }
        : null,
      attachments: attachments.map((attachment) => {
        if (!attachment.download_url) {
          throw new Error("Resend returned an attachment without a download link");
        }
        const url = attachment.download_url;
        return {
          id: attachment.id,
          filename: attachment.filename || "attachment",
          contentType: attachment.content_type,
          contentId: attachment.content_id?.replace(/^<|>$/g, "") ?? null,
          disposition: attachment.content_disposition,
          open: () => download(url),
        };
      }),
    };
  }

  async listInbound(next?: string) {
    const { data, has_more } = await this.client.listReceived({ limit: 100, after: next });
    const ids = data.map((email) => email.id);
    return { ids, next: has_more ? ids.at(-1) : undefined };
  }
}

// Resend names records relative to the zone, and for a subdomain the zone is usually its
// parent: reply.acme.com's records come as "send.reply". A name that already ends in one
// of the domain's own leading labels is relative to the parent; anything else is relative
// to the domain. Full names are kept.
export function resendRecordName(name: string, domain: string) {
  const relative = name.trim().toLowerCase().replace(/\.$/, "");
  if (!relative || relative === "@") return domain;
  if (relative === domain || relative.endsWith(`.${domain}`)) return relative;
  const labels = domain.split(".");
  for (let i = labels.length - 2; i >= 1; i--) {
    const prefix = labels.slice(0, i).join(".");
    if (relative === prefix || relative.endsWith(`.${prefix}`)) return `${relative}.${labels.slice(i).join(".")}`;
  }
  return `${relative}.${domain}`;
}

const RECORD_TYPES = new Set(["CNAME", "MX", "TXT"]);

// Resend's records for the domain, with DMARC when it has none. The MX on the domain
// itself is for receiving and is never written over another one.
export function resendDomainRecords(domain: string, records: ResendDomainRecord[], options: { needsDmarc: boolean }): DnsRecord[] {
  const result: DnsRecord[] = [];
  for (const record of records) {
    if (!RECORD_TYPES.has(record.type)) continue;
    const name = resendRecordName(record.name, domain);
    const value = record.value.replace(/^"|"$/g, "");
    const type = record.type as DnsRecord["type"];
    const receiving = type === "MX" && name === domain;
    result.push({
      type,
      name,
      value,
      ...(type === "MX" ? { priority: Number(record.priority ?? 10) } : {}),
      purpose: receiving
        ? "Delivers mail for this domain to Resend"
        : type === "MX" ? "Receives bounces, so SPF passes for your domain"
        : record.record === "DKIM" ? "Signs your mail with DKIM and verifies the domain"
        : value.toLowerCase().startsWith("v=spf1") ? "Lets Resend send for your domain (SPF)"
        : type === "CNAME" ? "Tracks opens and clicks. Optional"
        : "Needed by Resend",
      ...(receiving ? { keepExisting: true } : {}),
    });
  }
  if (options.needsDmarc) result.push(dmarcRecord(domain));
  return result;
}
