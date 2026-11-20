import { CtaButton, EmailLayout, LinkFallback, Muted, P } from "../layout";

export default function WorkspaceInvite({ inviter, workspace, url }: { inviter: string; workspace: string; url: string }) {
  return (
    <EmailLayout preview={`${inviter} wants you in ${workspace}.`} heading={`Join ${workspace}`}>
      <P>
        <strong>{inviter}</strong> invited you to <strong>{workspace}</strong> on HelloBox, where the team reads and
        answers the email sent to its domain together.
      </P>
      <CtaButton href={url}>Accept invite</CtaButton>
      <Muted>This invite expires in 7 days. If you weren&apos;t expecting it, you can ignore this email.</Muted>
      <LinkFallback href={url} />
    </EmailLayout>
  );
}

WorkspaceInvite.PreviewProps = { inviter: "Grace Hopper", workspace: "Acme", url: "https://hellobox.app/invite?token=preview" };
