import { Callout, CtaButton, EmailLayout, formatDate, Muted, P, SITE_URL } from "../layout";

export type SecurityChange = "password_changed" | "password_added" | "two_factor_disabled";

const COPY: Record<SecurityChange, { subject: string; heading: string; body: string }> = {
  password_changed: {
    subject: "Your HelloBox password was changed",
    heading: "Your password was changed",
    body: "The password for your HelloBox account was just changed, and other devices were signed out.",
  },
  password_added: {
    subject: "A password was added to your HelloBox account",
    heading: "You added a password",
    body: "A password was just added to your HelloBox account, so you can now sign in with your email too.",
  },
  two_factor_disabled: {
    subject: "Two-factor authentication was turned off",
    heading: "Two-factor is off",
    body: "Two-factor authentication was just turned off for your HelloBox account. Signing in now only needs your password.",
  },
};

export const securitySubject = (change: SecurityChange) => COPY[change].subject;

export default function SecurityNotice({ name, change, at }: { name: string; change: SecurityChange; at: Date }) {
  const copy = COPY[change];
  return (
    <EmailLayout preview={copy.body} heading={copy.heading}>
      <P>{name ? `Hi ${name}, ${copy.body.charAt(0).toLowerCase()}${copy.body.slice(1)}` : copy.body}</P>
      <Callout>Changed on {formatDate(at)}. If this was you, there&apos;s nothing else to do.</Callout>
      <P>If it wasn&apos;t you, reset your password right away and turn two-factor back on in settings.</P>
      <CtaButton href={`${SITE_URL}/forgot-password`}>Reset password</CtaButton>
      <Muted>We send this for every security change, so you always know what happens to your account.</Muted>
    </EmailLayout>
  );
}

SecurityNotice.PreviewProps = { name: "Ada", change: "password_changed", at: new Date("2026-11-07T12:00:00Z") };
