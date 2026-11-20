import { CtaButton, EmailLayout, LinkFallback, Muted, P } from "../layout";

export default function ResetPassword({ name, url }: { name: string; url: string }) {
  return (
    <EmailLayout preview="Choose a new password for HelloBox." heading="Reset your password">
      <P>{name ? `Hi ${name}, s` : "S"}omeone asked to reset the password for your HelloBox account. Choose a new one below.</P>
      <CtaButton href={url}>Choose a new password</CtaButton>
      <Muted>
        This link expires in 1 hour. If you didn&apos;t ask for this, you can ignore this email and your password stays
        the same.
      </Muted>
      <LinkFallback href={url} />
    </EmailLayout>
  );
}

ResetPassword.PreviewProps = { name: "Ada", url: "https://hellobox.app/reset-password?token=preview" };
