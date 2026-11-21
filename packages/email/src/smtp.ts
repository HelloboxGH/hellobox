import { createTransport, type Transporter } from "nodemailer";

export type OutgoingEmail = { from: string; to: string; replyTo?: string; subject: string; html: string; text: string };

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Nodemailer options from SMTP_URL. `smtps://user:pass@host:465` is TLS from the start;
 * `smtp://user:pass@host:587` must upgrade with STARTTLS, so a password never crosses the
 * network in the clear. Only a server on this machine (a local test mailbox) may skip TLS.
 * Special characters in the user name or password are percent-encoded in the URL.
 */
export function smtpOptions(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("SMTP_URL isn't a valid URL. Example: smtp://user:password@smtp.example.com:587");
  }
  if (url.protocol !== "smtp:" && url.protocol !== "smtps:") {
    throw new Error("SMTP_URL must start with smtp:// (port 587) or smtps:// (port 465)");
  }
  const secure = url.protocol === "smtps:";
  const host = url.hostname;
  return {
    host,
    port: url.port ? Number(url.port) : secure ? 465 : 587,
    secure,
    requireTLS: !secure && !LOCAL_HOSTS.has(host),
    auth: url.username ? { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) } : undefined,
    // A hung server must not hang a sign-up request for minutes.
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  };
}

let cached: { url: string; transport: Transporter } | undefined;

export function smtpTransport(url: string) {
  if (cached?.url !== url) cached = { url, transport: createTransport(smtpOptions(url)) };
  return cached.transport;
}

export async function sendViaSmtp(message: OutgoingEmail, transport: Pick<Transporter, "sendMail">) {
  await transport.sendMail({
    from: message.from,
    to: message.to,
    replyTo: message.replyTo,
    subject: message.subject,
    html: message.html,
    text: message.text,
  });
}
