import { CtaButton, EmailLayout, Muted, P } from "../layout";

// The free plan's hourly email: deliberately generic, with no sender, subject or count.
export default function NewMailDigest({ workspace, url }: { workspace: string; url: string }) {
  return (
    <EmailLayout preview={`You have new messages in ${workspace}.`} heading="You have new messages">
      <P>New mail arrived in {workspace} since we last wrote. Open HelloBox to read it.</P>
      <CtaButton href={url}>Open HelloBox</CtaButton>
      <Muted>
        {workspace} is on the Solo plan, so email notifications are an hourly notice without details. On a paid plan,
        you get a detailed email for each message, with the sender and a preview. Discord, Slack, Telegram, ntfy and
        browser notifications are instant and detailed on every plan. Change them in Settings, under Notifications.
      </Muted>
    </EmailLayout>
  );
}

NewMailDigest.PreviewProps = { workspace: "Acme", url: "https://hellobox.app/inbox" };
