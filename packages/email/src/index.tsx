import { render } from "@react-email/render";
import { isProduction, setting } from "@hellobox/config";
import type { ReactElement } from "react";
import { sendViaSmtp, smtpTransport } from "./smtp";

export { default as AccountDeleted } from "./templates/account-deleted";
export {
  default as TeamActivity, teamActivitySubject, type TeamActivityEmail, type TeamActivityItem,
} from "./templates/team-activity";
export { default as DomainClaim, domainClaimSubject, type DomainClaimEmail } from "./templates/domain-claim";
export { default as NewMail } from "./templates/new-mail";
export { default as NewMailDigest } from "./templates/new-mail-digest";
export { default as ResetPassword } from "./templates/reset-password";
export { default as SecurityNotice, securitySubject, type SecurityChange } from "./templates/security-notice";
export { default as SignupDigest, signupDigestSubject, type DigestSignup } from "./templates/signup-digest";
export { default as VerifyEmail } from "./templates/verify-email";
export { default as Welcome } from "./templates/welcome";
export { default as WorkspaceInvite } from "./templates/workspace-invite";

/** The reply address: the sender's username on REPLY_TO_DOMAIN, or nothing without it. */
export function defaultReplyTo(from: string, domain = setting("REPLY_TO_DOMAIN")): string | undefined {
  const host = domain?.trim().replace(/^@/, "");
  const user = /<?([^<>\s@]+)@[^<>\s@]+>?\s*$/.exec(from)?.[1];
  return host && user ? `${user}@${host}` : undefined;
}

// Product emails (verification links, password resets, invitations) use this instance's own
// account, never a customer's connection. Either an SMTP server (SMTP_URL) or a Resend API key
// (RESEND_API_KEY); SMTP wins when both are set. EMAIL_FROM is the sender, such as
// `HelloBox <hello@example.com>`, on a domain the sender is allowed to use.
export async function sendAppEmail(input: { to: string; subject: string; react: ReactElement; replyTo?: string }) {
  const [html, text] = await Promise.all([render(input.react), render(input.react, { plainText: true })]);
  const smtpUrl = setting("SMTP_URL")?.trim();
  const apiKey = setting("RESEND_API_KEY");
  if (!smtpUrl && !apiKey) {
    if (isProduction()) {
      throw new Error("SMTP_URL or RESEND_API_KEY is required in production");
    }
    console.info(`[email] to=${input.to} subject=${input.subject}\n${text}`);
    return;
  }
  const from = setting("EMAIL_FROM");
  if (!from) throw new Error(`EMAIL_FROM is required when ${smtpUrl ? "SMTP_URL" : "RESEND_API_KEY"} is set`);
  const replyTo = input.replyTo ?? defaultReplyTo(from);
  if (smtpUrl) {
    await sendViaSmtp({ from, to: input.to, replyTo, subject: input.subject, html, text }, smtpTransport(smtpUrl));
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "hellobox/1.0",
    },
    body: JSON.stringify({ from, to: input.to, reply_to: replyTo, subject: input.subject, html, text }),
  });
  if (!res.ok) throw new Error(`Could not send email: ${res.status}`);
}
