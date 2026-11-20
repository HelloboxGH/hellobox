import { CtaButton, EmailLayout, LinkFallback, Muted, P } from "../layout";

// Something a teammate did that someone should see right away.
export type TeamActivityItem = {
  kind: "assigned" | "mentioned";
  // Null when the teammate has since left.
  actor: string | null;
  subject: string;
  // Who wrote in, for context.
  from: string;
  // The note a mention is in.
  note?: string;
  url: string;
};

export type TeamActivityEmail = {
  workspace: string;
  items: TeamActivityItem[];
  // The conversation itself for one item, the inbox for several.
  url: string;
};

const subjectOf = (item: TeamActivityItem) => item.subject || "(no subject)";
const lineOf = (item: TeamActivityItem) =>
  item.kind === "assigned"
    ? `${item.actor ?? "A teammate"} assigned you “${subjectOf(item)}”`
    : `${item.actor ?? "A teammate"} mentioned you in “${subjectOf(item)}”`;

export function teamActivitySubject({ items }: Pick<TeamActivityEmail, "items">) {
  if (items.length === 1) return lineOf(items[0]!);
  const actors = new Set(items.map((item) => item.actor));
  const kinds = new Set(items.map((item) => item.kind));
  const [actor] = actors;
  const who = actors.size === 1 && actor ? actor : "Your team";
  if (kinds.size === 1 && kinds.has("assigned")) return `${who} assigned you ${items.length} conversations`;
  if (kinds.size === 1) return `${who} mentioned you ${items.length} times`;
  return `${who} needs you in ${items.length} conversations`;
}

// Sent when a teammate assigns someone a conversation or mentions them in a note, unless
// they turned team emails off. Everything from the same moment comes as one email.
export default function TeamActivity({ workspace, items, url }: TeamActivityEmail) {
  const one = items.length === 1;
  return (
    <EmailLayout preview={teamActivitySubject({ items })} heading={one ? "Your team needs you" : `${items.length} updates from your team`}>
      {items.map((item, index) => (
        <P key={index}>
          <strong>{lineOf(item)}</strong>
          {item.note ? (
            <>
              <br />
              <span style={{ color: "#3f3f46" }}>“{item.note}”</span>
            </>
          ) : null}
          <br />
          <span style={{ color: "#52525b" }}>From {item.from}</span>
        </P>
      ))}
      <CtaButton href={url}>{one ? "Open the conversation" : "Open HelloBox"}</CtaButton>
      <Muted>
        You get these when a teammate assigns you a conversation or mentions you in {workspace}. Turn them off in
        Settings, under Notifications.
      </Muted>
      <LinkFallback href={url} />
    </EmailLayout>
  );
}

TeamActivity.PreviewProps = {
  workspace: "Acme",
  items: [
    { kind: "mentioned", actor: "Amara Okafor", subject: "Can't verify our domain", from: "Priya Raman <priya@example.com>", note: "@Léo Martin can you check their TXT record?", url: "https://hellobox.app/inbox?thread=1" },
  ],
  url: "https://hellobox.app/inbox?thread=1",
} satisfies TeamActivityEmail;
