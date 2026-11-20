import { EmailLayout, Muted, P } from "../layout";

export default function AccountDeleted({ name }: { name: string }) {
  return (
    <EmailLayout preview="Your account and its data are gone." heading="Your account is deleted">
      <P>
        {name ? `Hi ${name}, y` : "Y"}our HelloBox account has been deleted, along with the workspaces you owned and their mail.
      </P>
      <P>Thanks for giving HelloBox a try. If you ever want to come back, you&apos;re always welcome.</P>
      <Muted>If you didn&apos;t do this, reply to this email right away.</Muted>
    </EmailLayout>
  );
}

AccountDeleted.PreviewProps = { name: "Ada" };
