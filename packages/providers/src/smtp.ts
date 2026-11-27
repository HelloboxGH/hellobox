import { readObject } from "@hellobox/storage";
import { createTransport, type Transporter } from "nodemailer";
import { buildRawEmail } from "./mime";
import type { MailProvider, OutgoingMessage, ProviderDomain, SentMessage } from "./types";

// Any SMTP server the customer sends with: Google Workspace's relay, Zoho, Fastmail, their
// own. It only sends. Its domains receive with HelloBox, and there are no delivery events,
// so its mail shows "Sent", never "Delivered".

// 465 is TLS from the start; the others must upgrade with STARTTLS. 25 is often blocked
// outbound, but some relays only listen there.
export const SMTP_PORTS = [465, 587, 2525, 25] as const;
export type SmtpPort = (typeof SMTP_PORTS)[number];

export interface SmtpSettings {
  host: string;
  port: SmtpPort;
  username: string;
  password: string;
}

// The server refused the username or password. Reconnecting fixes it; retrying doesn't.
export class SmtpAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmtpAuthError";
  }
}

// Anything else the server or the connection said, worded for the person connecting.
export class SmtpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmtpError";
  }
}

export const isSmtpAuthError = (error: unknown) => error instanceof SmtpAuthError;

const isHostname = (value: string) =>
  value.length <= 253 && /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value);

// Checks what was typed. The address it points to is checked on every connection.
export function smtpSettingsProblem(settings: { host: string; port: number }) {
  if (!isHostname(settings.host)) return "Enter the server's name, such as smtp.example.com";
  if (!(SMTP_PORTS as readonly number[]).includes(settings.port)) return `Use port ${SMTP_PORTS.join(", ")}`;
  return null;
}

// Resolves the host to one public address, or throws. Given by the caller so the check
// runs on every connection, and so the server can't be a name for something internal.
export type ResolvePublic = (host: string) => Promise<string>;

// Nodemailer's error codes, turned into what to fix.
export function smtpError(error: unknown): Error {
  const code = (error as { code?: string; responseCode?: number } | null)?.code;
  const response = (error as { response?: string } | null)?.response?.trim();
  if (code === "EAUTH") return new SmtpAuthError(`The server refused the username or password${response ? `: ${response}` : ""}`);
  if (code === "ETLS") return new SmtpError("The server didn't offer a secure connection (STARTTLS), so nothing was sent");
  if (code === "ECONNECTION" || code === "ETIMEDOUT" || code === "ESOCKET" || code === "EDNS") {
    return new SmtpError(`Couldn't reach the server${error instanceof Error && error.message ? `: ${error.message}` : ""}`);
  }
  if (code === "EENVELOPE" || code === "EMESSAGE") {
    return new SmtpError(`The server refused the email${response ? `: ${response}` : ""}`);
  }
  return error instanceof Error ? error : new SmtpError(String(error));
}

const bareAddress = (value: string) => (value.match(/<([^>]+)>/)?.[1] ?? value).trim();

export interface SmtpTarget extends SmtpSettings {
  // The domains the customer added: the server can't list them.
  domains: string[];
}

export class SmtpProvider implements MailProvider {
  readonly kind = "smtp" as const;
  readonly capabilities = { receiving: false, backfill: false, refreshDomains: false };

  constructor(
    readonly target: SmtpTarget,
    private readonly resolve: ResolvePublic,
    // Tests pass a fake transport.
    private readonly transportFor: (options: Parameters<typeof createTransport>[0]) => Pick<Transporter, "sendMail" | "verify" | "close"> = createTransport,
  ) {}

  // A fresh connection each time, to the address checked just now. The certificate is
  // still checked against the host's name.
  private async transport() {
    const { host, port, username, password } = this.target;
    const address = await this.resolve(host);
    const secure = port === 465;
    return this.transportFor({
      host: address,
      port,
      secure,
      requireTLS: !secure,
      auth: { user: username, pass: password },
      tls: { servername: host, rejectUnauthorized: true, minVersion: "TLSv1.2" },
      // A hung server must not hold the outbox for minutes.
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 60_000,
    });
  }

  // Signs in without sending anything, when connecting.
  async verify() {
    const transport = await this.transport();
    try {
      await transport.verify();
    } catch (error) {
      throw smtpError(error);
    } finally {
      transport.close();
    }
  }

  // There's no API to list them: they're the ones the customer typed. There's nothing to
  // verify at the server either, so they're ready to send from at once.
  async listDomains(): Promise<ProviderDomain[]> {
    return this.target.domains.map((name) => ({ id: name, name, status: "verified", sending: true, receiving: false }));
  }

  // The message is built here, our Message-ID included, and sent as it is, so replies
  // thread. Bcc goes only in the envelope.
  async send(message: OutgoingMessage): Promise<SentMessage> {
    const attachments = await Promise.all(
      (message.attachments ?? []).map(async (file) => ({
        filename: file.filename,
        contentType: file.contentType,
        contentId: file.contentId,
        content: new Uint8Array(await new Response(await readObject(file.storageKey)).arrayBuffer()),
      })),
    );
    const raw = Buffer.from(await buildRawEmail(message, attachments));
    const recipients = [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])].map(bareAddress);
    const transport = await this.transport();
    try {
      const info = await transport.sendMail({ envelope: { from: bareAddress(message.from), to: recipients }, raw });
      const id = message.headers?.["Message-ID"] ?? (info.messageId as string | undefined) ?? crypto.randomUUID();
      return { id: id.replace(/^<|>$/g, "") };
    } catch (error) {
      throw smtpError(error);
    } finally {
      transport.close();
    }
  }
}
