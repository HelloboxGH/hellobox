import { render } from "@react-email/render";
import type { ReactElement } from "react";

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
export function defaultReplyTo(from: string, domain = process.env.REPLY_TO_DOMAIN): string | undefined {
  const host = domain?.trim().replace(/^@/, "");
  const user = /<?([^<>\s@]+)@[^<>\s@]+>?\s*$/.exec(from)?.[1];
  return host && user ? `${user}@${host}` : undefined;
}

// Product emails use this instance's own Resend key, never a customer's connection. EMAIL_FROM
// is a verified sender on that account, such as `HelloBox <hello@example.com>`.
export async function sendAppEmail(input: { to: string; subject: string; react: ReactElement; replyTo?: string }) {
  const [html, text] = await Promise.all([render(input.react), render(input.react, { plainText: true })]);
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("RESEND_API_KEY is required in production");
    }
    console.info(`[email] to=${input.to} subject=${input.subject}\n${text}`);
    return;
  }
  const from = process.env.EMAIL_FROM;
  if (!from) throw new Error("EMAIL_FROM is required when RESEND_API_KEY is set");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "hellobox/1.0",
    },
    body: JSON.stringify({ from, to: input.to, reply_to: input.replyTo ?? defaultReplyTo(from), subject: input.subject, html, text }),
  });
  if (!res.ok) throw new Error(`Could not send email: ${res.status}`);
}
