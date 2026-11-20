import { CtaButton, EmailLayout, LinkFallback, Muted, P } from "../layout";

export default function VerifyEmail({ name, url }: { name: string; url: string }) {
  return (
    <EmailLayout preview="One click and your inbox is ready." heading="Confirm your email">
      <P>{name ? `Hi ${name}, t` : "T"}hanks for signing up. Confirm this is your address and we&apos;ll take you straight into HelloBox.</P>
      <CtaButton href={url}>Confirm email</CtaButton>
      <Muted>If you didn&apos;t create an account, you can ignore this email.</Muted>
      <LinkFallback href={url} />
    </EmailLayout>
  );
}

VerifyEmail.PreviewProps = { name: "Ada", url: "https://hellobox.app/api/auth/verify-email?token=preview" };
