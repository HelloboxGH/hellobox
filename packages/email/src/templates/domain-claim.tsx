import { Callout, CtaButton, Details, EmailLayout, formatDate, Muted, P, SITE_URL } from "../layout";

// Every email about a domain one workspace claims from another (see domainTakeovers in
// the schema), and "Request access". Holder emails go to the admins of the workspace
// that has the domain; requester emails go to whoever asked.
export type DomainClaimEmail =
  | { kind: "notice"; domain: string; workspace: string; endsAt: Date }
  | { kind: "taken"; domain: string; workspace: string }
  | { kind: "access"; domain: string; workspace: string; requester: { name: string; email: string; workspace: string } }
  | { kind: "claimed"; domain: string; enabled: boolean }
  | { kind: "stopped"; domain: string; reason: "kept" | "active" | "dns" | "unverified" };

const SETTINGS = `${SITE_URL}/settings?tab=connection`;

export function domainClaimSubject(email: DomainClaimEmail) {
  switch (email.kind) {
    case "notice":
      return `Action needed: ${email.domain} is being claimed by another workspace`;
    case "taken":
      return `${email.domain} moved to another workspace`;
    case "access":
      return `Someone asked for access to ${email.domain}`;
    case "claimed":
      return `${email.domain} is now yours in HelloBox`;
    case "stopped":
      return `Your claim on ${email.domain} was stopped`;
  }
}

const STOPPED: Record<Extract<DomainClaimEmail, { kind: "stopped" }>["reason"], string> = {
  kept: "An admin of the workspace that has it chose to keep it.",
  active: "The workspace that has it was used again during the notice period.",
  dns: "The TXT record proving you control its DNS was no longer there when the notice ended.",
  unverified: "Your email provider no longer reports the domain as verified.",
};

export default function DomainClaim(email: DomainClaimEmail) {
  const subject = domainClaimSubject(email);
  if (email.kind === "notice") {
    return (
      <EmailLayout preview={subject} heading={`${email.domain} is being claimed`}>
        <P>
          Someone who controls the DNS for {email.domain} has asked to use it in their own HelloBox workspace.
          Nobody has used {email.workspace} for over 90 days, so the domain moves to them on {formatDate(email.endsAt)} unless
          you keep it.
        </P>
        <Callout tone="warning">Signing in to {email.workspace}, or choosing Keep domain in Settings, stops this.</Callout>
        <CtaButton href={SETTINGS}>Keep domain</CtaButton>
        <Muted>If you no longer use {email.domain} with HelloBox, you don&apos;t need to do anything. Its mail stays readable in {email.workspace}.</Muted>
      </EmailLayout>
    );
  }
  if (email.kind === "taken") {
    return (
      <EmailLayout preview={subject} heading={`${email.domain} moved`}>
        <P>
          {email.domain} is now used by another HelloBox workspace, which proved it controls the domain&apos;s DNS. It has been
          removed from {email.workspace}.
        </P>
        <P>Its mailboxes and mail are still in {email.workspace} to read, but nothing new arrives or is sent from them.</P>
        <Muted>If this wasn&apos;t expected, reply to this email and we&apos;ll look into it.</Muted>
      </EmailLayout>
    );
  }
  if (email.kind === "access") {
    return (
      <EmailLayout preview={subject} heading={`Access to ${email.domain}`}>
        <P>Someone tried to add {email.domain}, which is on in {email.workspace}, to their own HelloBox workspace, and asked for access instead.</P>
        <Details
          rows={[
            ["Name", email.requester.name || "Not given"],
            ["Email", email.requester.email],
            ["Their workspace", email.requester.workspace],
          ]}
        />
        <P>If they should have it, invite them to {email.workspace} from Settings, Team. Otherwise you can ignore this.</P>
        <CtaButton href={`${SITE_URL}/settings?tab=team`}>Open Team</CtaButton>
        <Muted>We didn&apos;t tell them who you are or which workspace has the domain.</Muted>
      </EmailLayout>
    );
  }
  if (email.kind === "claimed") {
    return (
      <EmailLayout preview={subject} heading={`${email.domain} is yours`}>
        <P>The notice period ended, so {email.domain} has moved to your workspace.</P>
        {email.enabled ? (
          <P>It&apos;s on, and you can add mailboxes for it now.</P>
        ) : (
          <Callout tone="warning">It&apos;s switched off because your plan has no room for another domain. Upgrade, or turn another domain off.</Callout>
        )}
        <CtaButton href={SETTINGS}>Open Domains</CtaButton>
        <Muted>You can remove the _hellobox TXT record now.</Muted>
      </EmailLayout>
    );
  }
  return (
    <EmailLayout preview={subject} heading={`Claim on ${email.domain} stopped`}>
      <P>Your claim on {email.domain} was stopped. {STOPPED[email.reason]}</P>
      <P>You can still ask the workspace that has it for access from Settings, Domains.</P>
      <CtaButton href={SETTINGS}>Open Domains</CtaButton>
    </EmailLayout>
  );
}

DomainClaim.PreviewProps = { kind: "notice", domain: "acme.com", workspace: "Acme", endsAt: new Date("2026-11-25T12:00:00Z") };
