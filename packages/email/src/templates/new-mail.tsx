import { CtaButton, EmailLayout, LinkFallback, Muted, P } from "../layout";

type Detail = { from: string; subject: string; mailbox: string; excerpt?: string };

// Instant notification on paid plans. Without previews, it only says where mail arrived.
export default function NewMail({
  workspace, url, count, mailbox, details,
}: { workspace: string; url: string; count: number; mailbox: string; details: Detail[] | null }) {
  const heading = count > 1 ? `${count} new messages` : `New mail in ${mailbox}`;
  return (
    <EmailLayout preview={details?.[0] ? `${details[0].from}: ${details[0].subject}` : heading} heading={heading}>
      {details ? (
        details.map((item, index) => (
          <P key={index}>
            <strong>{item.subject || "(no subject)"}</strong>
            <br />
            From {item.from} to {item.mailbox}
            {item.excerpt ? (
              <>
                <br />
                <span style={{ color: "#52525b" }}>{item.excerpt}</span>
              </>
            ) : null}
          </P>
        ))
      ) : (
        <P>New mail arrived in {workspace}. Open HelloBox to read it.</P>
      )}
      <CtaButton href={url}>Open in HelloBox</CtaButton>
      <Muted>You get these because you turned on email notifications for {workspace}. Change them in Settings, under Notifications.</Muted>
      <LinkFallback href={url} />
    </EmailLayout>
  );
}

NewMail.PreviewProps = {
  workspace: "Acme",
  url: "https://hellobox.app/inbox",
  count: 1,
  mailbox: "support@acme.com",
  details: [{ from: "Priya Raman <priya@example.com>", subject: "Can't verify our domain", mailbox: "support@acme.com", excerpt: "We added the TXT record yesterday but…" }],
};
