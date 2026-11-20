// The Northwind workspace: shared and personal mailboxes, two teammates, labels, contacts
// and about 45 conversations across every folder and category, dated relative to now.
// `bun run db:seed` builds it for a local account, and the public demo builds one per
// visitor (packages/mail/src/demo).
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

const {
  workspaces, members, connections, domains, mailboxes, mailboxMembers, threads, messages, threadUserState,
  labels, threadLabels, contacts, threadNotes,
} = schema;

export const DEMO_DOMAIN = "northwind.test";
const DOMAIN = DEMO_DOMAIN;

type Db = PostgresJsDatabase<typeof schema>;

export interface DemoWorkspaceInput {
  name: string;
  owner: { id: string; name: string };
  // Amara (admin) and Léo (member), already in the user table.
  teammateIds: [string, string];
  demoExpiresAt?: Date;
  connection: { provider: (typeof schema.providerKindEnum.enumValues)[number]; status: (typeof schema.connectionStatusEnum.enumValues)[number] };
  now?: number;
}

export const DEMO_TEAMMATES = [
  { name: "Amara Okafor", local: "amara" },
  { name: "Léo Martin", local: "leo" },
] as const;

type Folder = "inbox" | "archive" | "spam" | "trash";
type Category = "primary" | "notifications" | "purchases" | "newsletters";
type Seed = {
  // hello, support, billing, or "me" for the owner's personal mailbox.
  mailbox: string;
  from: [string, string];
  subject: string;
  body: string[];
  // Replies after the first message: ours ("out") or theirs ("in").
  replies?: { dir: "in" | "out"; body: string; by?: string }[];
  hoursAgo: number;
  folder?: Folder;
  category?: Category;
  unread?: boolean;
  starred?: boolean;
  important?: boolean;
  labels?: string[];
  assigned?: number;
  note?: string;
  html?: boolean;
};

const SEEDS: Seed[] = [
  { mailbox: "support", from: ["Priya Raman", "priya@lumenstack.test"], subject: "Can't verify our domain", hoursAgo: 0.3, unread: true, important: true, labels: ["Customers"], assigned: 0,
    body: ["Hi there,", "We added the TXT record yesterday but the dashboard still says pending. Is there something else we need to do?", "Thanks,\nPriya"] },
  { mailbox: "hello", from: ["Marcus Bell", "marcus@foldline.test"], subject: "Partnership idea", hoursAgo: 1.5, unread: true, labels: ["Partners"],
    body: ["Hey!", "I run a small newsletter for indie founders (about 9k readers). Would you be open to a feature next month? Happy to share numbers.", "Marcus"] },
  { mailbox: "support", from: ["Sofia Lindqvist", "sofia@kettle.test"], subject: "Re: Replies going to spam", hoursAgo: 3, starred: true, labels: ["Customers", "Bugs"], assigned: 1,
    note: "Looks like their DMARC is p=reject without DKIM alignment. Sent them the guide.",
    body: ["Hello,", "Since Tuesday some replies from our customers end up in Spam on your side. Example attached in the forwarded mail.", "Sofia"],
    replies: [
      { dir: "out", body: "Thanks Sofia, could you send the full headers of one of those messages? We'll check the spam score." },
      { dir: "in", body: "Sure, here they are. The score says 6.2 with DMARC_REJECT." },
      { dir: "out", body: "Got it. Your DMARC policy rejects mail that isn't DKIM aligned. Our guide explains the two records to add." },
    ] },
  { mailbox: "hello", from: ["Tom Asante", "tom@paperplane.test"], subject: "Quick question about pricing", hoursAgo: 5, unread: true,
    body: ["Hi,", "Does the Starter plan count subdomains as separate domains? We have mail.paperplane.test and reply.paperplane.test.", "Cheers, Tom"] },
  { mailbox: "billing", from: ["Ledgerly", "receipts@ledgerly.test"], subject: "Your receipt for November", hoursAgo: 8, category: "purchases", html: true,
    body: ["Thanks for your payment of $20.00 for the Team plan.", "Invoice LDG-2026-1142 · Paid with card ending 4242"] },
  { mailbox: "support", from: ["Shipyard CI", "builds@shipyard.test"], subject: "Build failed on main: 3 tests", hoursAgo: 9, category: "notifications", unread: true,
    body: ["Build #1931 failed on main.", "threads.test.ts › updates many threads\nlabels.test.ts › applies to selection\nmailbox.test.ts › soft delete"] },
  { mailbox: "hello", from: ["Indie Weekly", "issue@indieweekly.test"], subject: "Issue #88: Pricing pages that convert", hoursAgo: 11, category: "newsletters", html: true,
    body: ["This week: five pricing pages taken apart, a founder who doubled conversions by removing a plan, and the tools readers loved in October."] },
  { mailbox: "me", from: ["Nadia Haddad", "nadia@haddad.test"], subject: "Coffee next week?", hoursAgo: 14, unread: true, starred: true,
    body: ["Hey!", "I'm in town Tuesday to Thursday. Coffee? I want to hear how the launch went.", "N."] },
  { mailbox: "support", from: ["Jonas Weber", "jonas@brightfield.test"], subject: "Export to CSV?", hoursAgo: 20, labels: ["Customers", "Follow up"],
    body: ["Hello team,", "Is there a way to export all conversations from a mailbox to CSV for our records?", "Best regards,\nJonas"],
    replies: [{ dir: "out", body: "Hi Jonas, not to CSV yet, but you can download any conversation as HTML or PDF. CSV export is on our list." }] },
  { mailbox: "hello", from: ["Elena García", "elena@mosaico.test"], subject: "Love the product", hoursAgo: 26,
    body: ["Just wanted to say: we switched from forwarding to Gmail last week and the team is so much calmer. Thank you!", "Elena"],
    replies: [{ dir: "out", body: "That made our day, Elena. Thanks for writing!" }] },
  { mailbox: "support", from: ["Kenji Watanabe", "kenji@origami.test"], subject: "Webhook signature mismatch", hoursAgo: 30, important: true, labels: ["Bugs"], assigned: 0,
    body: ["Hi,", "After rotating our signing key, inbound mail stopped arriving. Logs show 'signature mismatch'. Did we miss a step?", "Kenji"] },
  { mailbox: "billing", from: ["Ledgerly", "billing@ledgerly.test"], subject: "Payment failed for invoice LDG-2026-1098", hoursAgo: 40, category: "notifications", important: true,
    body: ["We couldn't charge your card for invoice LDG-2026-1098. We'll try again in 3 days.", "Update your payment method to avoid interruption."] },
  { mailbox: "hello", from: ["Ravi Menon", "ravi@tinyforms.test"], subject: "Agency plan?", hoursAgo: 48,
    body: ["We manage email for about 12 clients. Is there a plan that lets us keep each client in its own workspace with one bill?", "Ravi"] },
  { mailbox: "support", from: ["Shipyard CI", "builds@shipyard.test"], subject: "Build passed on main", hoursAgo: 50, category: "notifications",
    body: ["Build #1930 passed on main in 4m 12s."] },
  { mailbox: "hello", from: ["The Ops Digest", "hello@opsdigest.test"], subject: "Postgres tips you'll actually use", hoursAgo: 60, category: "newsletters",
    body: ["Partial indexes, generated columns and why your trigram index isn't used. Plus: a reader question on connection pooling."] },
  { mailbox: "me", from: ["Amara Okafor", "amara@northwind.test"], subject: "Notes from the call with Kettle", hoursAgo: 70, labels: ["Customers"],
    body: ["Summary: they want SSO before the end of the quarter, and a shared inbox for six people. Pricing is fine. Next step: send the Business plan details."] },
  { mailbox: "support", from: ["Hannah Cole", "hannah@greenlight.test"], subject: "Attachment won't open", hoursAgo: 80, labels: ["Bugs"],
    body: ["The PDF a customer sent shows as 0 bytes for us. Can you check?", "Hannah"],
    replies: [
      { dir: "out", body: "Hi Hannah, thanks. We found it: the sender's provider split the file. It's fixed for new mail." },
      { dir: "in", body: "Confirmed, works now. Thank you!" },
    ] },
  { mailbox: "billing", from: ["CloudHost", "invoices@cloudhost.test"], subject: "Invoice for October: $43.18", hoursAgo: 96, category: "purchases",
    body: ["Your invoice for October is ready. Total: $43.18. It will be charged on November 15."] },
  { mailbox: "hello", from: ["Yuki Tanaka", "yuki@kumo.test"], subject: "Feature request: snooze to a date", hoursAgo: 110, labels: ["Follow up"],
    body: ["Snooze is great but I'd like to pick an exact date, like 'the 3rd of next month'.", "Yuki"] },
  { mailbox: "support", from: ["Omar Farouk", "omar@sandline.test"], subject: "Team invite expired", hoursAgo: 130,
    body: ["My colleague's invite link says it expired. Can you resend it?", "Omar"],
    replies: [{ dir: "out", body: "Done, Omar. A new invite is on its way and it's valid for 7 days." }] },
  { mailbox: "hello", from: ["Indie Weekly", "issue@indieweekly.test"], subject: "Issue #87: Cold email that doesn't feel cold", hoursAgo: 180, category: "newsletters",
    body: ["Short, warm, specific. Three examples that got replies, and one that didn't."] },
  { mailbox: "me", from: ["Léo Martin", "leo@northwind.test"], subject: "Draft for the launch post", hoursAgo: 200,
    body: ["Here's a first draft. I kept it short and put the provider list up top. Tell me what to cut."] },
  { mailbox: "support", from: ["Grace Kim", "grace@pebble.test"], subject: "How do I remove a domain?", hoursAgo: 240, folder: "archive",
    body: ["We stopped using old.pebble.test. How do I remove it without losing the mail?"],
    replies: [{ dir: "out", body: "Settings → Domains → Remove. The mail stays readable, and adding it back restores everything." }] },
  { mailbox: "hello", from: ["Fatima Diallo", "fatima@baobab.test"], subject: "Thanks for the quick fix", hoursAgo: 300, folder: "archive",
    body: ["All good on our side now. Have a nice weekend!"] },
  { mailbox: "billing", from: ["Ledgerly", "receipts@ledgerly.test"], subject: "Your receipt for October", hoursAgo: 720, folder: "archive", category: "purchases",
    body: ["Thanks for your payment of $20.00 for the Team plan."] },
  { mailbox: "support", from: ["Lucky Winner Dept", "prize@claim-now.test"], subject: "You have won $1,000,000!!!", hoursAgo: 4, folder: "spam",
    body: ["Congratulations! Click below to claim your prize before it expires."] },
  { mailbox: "hello", from: ["SEO Rockets", "growth@seo-rockets.test"], subject: "Page 1 on Google in 7 days", hoursAgo: 30, folder: "spam",
    body: ["We noticed your site isn't ranking. Our team can get you to page 1 guaranteed."] },
  { mailbox: "hello", from: ["Crypto Gains", "alerts@moon-coin.test"], subject: "Your wallet needs verification", hoursAgo: 90, folder: "spam",
    body: ["Verify your wallet within 24 hours or it will be suspended."] },
  { mailbox: "support", from: ["Old Vendor", "news@oldvendor.test"], subject: "We're changing our terms", hoursAgo: 60, folder: "trash", category: "notifications",
    body: ["We're updating our terms of service, effective next month."] },
  { mailbox: "hello", from: ["Event Bot", "events@meetups.test"], subject: "Reminder: Founders meetup tonight", hoursAgo: 150, folder: "trash", category: "notifications",
    body: ["See you at 7pm. Bring a friend!"] },
];

// A few more quiet ones, so the list scrolls and "Load more" shows up.
const people: [string, string][] = [
  ["Ana Souza", "ana@ondas.test"], ["Ben Carter", "ben@cartwheel.test"], ["Chloé Dubois", "chloe@atelier.test"],
  ["David Mensah", "david@kente.test"], ["Eva Novak", "eva@lipa.test"], ["Felix Braun", "felix@hafen.test"],
  ["Gita Shah", "gita@chai.test"], ["Hugo Silva", "hugo@mar.test"], ["Ines Moreau", "ines@prairie.test"],
  ["Jamal Idris", "jamal@oasis.test"], ["Kofi Boateng", "kofi@adinkra.test"], ["Lina Petrova", "lina@bereza.test"],
  ["Mateo Rossi", "mateo@pane.test"], ["Noor Aziz", "noor@sahara.test"], ["Owen Hughes", "owen@cwm.test"],
];
const topics = [
  "Question about the API", "Can we change the sender name?", "Invoice address", "Is there a mobile app?",
  "Reply-To setup", "MCP with Claude", "Moving from Gmail forwarding", "Templates with variables",
];
people.forEach((person, i) =>
  SEEDS.push({
    mailbox: i % 3 === 0 ? "hello" : "support",
    from: person,
    subject: topics[i % topics.length]!,
    hoursAgo: 330 + i * 26,
    folder: i % 4 === 3 ? "archive" : "inbox",
    unread: i % 5 === 0,
    body: [`Hi,`, `${topics[i % topics.length]} — could you point me in the right direction?`, person[0].split(" ")[0]!],
    replies: i % 2 === 0 ? [{ dir: "out", body: "Sure! Here's how it works, and a link to the guide." }] : undefined,
  }),
);


export async function createDemoWorkspace(db: Db, input: DemoWorkspaceInput) {
  const { owner, teammateIds } = input;
  const now = input.now ?? Date.now();
  const [workspace] = await db
    .insert(workspaces)
    .values({ name: input.name, demoExpiresAt: input.demoExpiresAt ?? null })
    .returning();
  if (!workspace) throw new Error("Couldn't create the workspace");
  const ws = workspace.id;
  await db.insert(members).values([
    { workspaceId: ws, userId: owner.id, role: "owner" },
    { workspaceId: ws, userId: teammateIds[0], role: "admin" },
    { workspaceId: ws, userId: teammateIds[1], role: "member" },
  ]);

  const [connection] = await db
    .insert(connections)
    .values({ workspaceId: ws, provider: input.connection.provider, status: input.connection.status, config: {} })
    .returning();
  const connectionId = connection!.id;
  const [main, reply] = await db
    .insert(domains)
    .values([
      { workspaceId: ws, connectionId, providerDomainId: "demo-1", name: DOMAIN, enabled: true, status: "verified", sendingEnabled: true, receivingEnabled: true },
      { workspaceId: ws, connectionId, providerDomainId: "demo-2", name: `reply.${DOMAIN}`, enabled: true, status: "verified", sendingEnabled: true, receivingEnabled: true },
    ])
    .returning();

  const myLocal = (owner.name.split(" ")[0] || "me").toLowerCase().replace(/[^a-z0-9]/g, "") || "me";
  const boxes = await db
    .insert(mailboxes)
    .values([
      { workspaceId: ws, domainId: main!.id, address: `hello@${DOMAIN}`, displayName: "Northwind" },
      { workspaceId: ws, domainId: main!.id, address: `support@${DOMAIN}`, displayName: "Northwind Support" },
      { workspaceId: ws, domainId: reply!.id, address: `billing@reply.${DOMAIN}`, displayName: "Northwind Billing" },
      { workspaceId: ws, domainId: main!.id, address: `${myLocal}@${DOMAIN}`, displayName: owner.name, personalUserId: owner.id },
    ])
    .returning();
  const box = Object.fromEntries(boxes.map((b) => [b.address.split("@")[0], b])) as Record<string, (typeof boxes)[number]>;
  const shared = boxes.filter((b) => !b.personalUserId);
  await db.insert(mailboxMembers).values([
    ...shared.map((b) => ({ mailboxId: b.id, userId: owner.id })),
    ...shared.map((b) => ({ mailboxId: b.id, userId: teammateIds[0] })),
    { mailboxId: box.support!.id, userId: teammateIds[1] },
  ]);

  const labelRows = await db
    .insert(labels)
    .values([
      { workspaceId: ws, name: "Customers", color: "blue" },
      { workspaceId: ws, name: "Bugs", color: "red" },
      { workspaceId: ws, name: "Partners", color: "green" },
      { workspaceId: ws, name: "Follow up", color: "amber" },
    ])
    .returning();
  const label = Object.fromEntries(labelRows.map((l) => [l.name, l.id]));

  const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const htmlOf = (paragraphs: string[], branded: boolean) =>
    branded
      ? `<div style="background:#f4f4f5;padding:24px;font-family:Helvetica,Arial,sans-serif"><div style="max-width:520px;margin:auto;background:#fff;border-radius:12px;padding:28px;color:#18181b">${paragraphs
          .map((p) => `<p style="margin:0 0 14px;line-height:1.5">${escape(p).replace(/\n/g, "<br>")}</p>`)
          .join("")}</div></div>`
      : paragraphs.map((p) => `<p>${escape(p).replace(/\n/g, "<br>")}</p>`).join("");

  const normalize = (subject: string) => subject.replace(/^(re|fwd?):\s*/i, "").trim().toLowerCase();
  let count = 0;
  for (const seed of SEEDS) {
    const mailbox = box[seed.mailbox === "me" ? myLocal : seed.mailbox] ?? box.hello!;
    const ours = { address: mailbox.address, name: mailbox.displayName ?? undefined };
    const theirs = { address: seed.from[1], name: seed.from[0] };
    const replies = seed.replies ?? [];
    const firstAt = now - seed.hoursAgo * 3_600_000;
    // Replies come a few hours apart, but never in the future.
    const times = [firstAt, ...replies.map((_, i) => Math.min(firstAt + (i + 1) * 2.5 * 3_600_000, now - (replies.length - i) * 60_000))];
    const all = [{ dir: "in" as const, body: seed.body.join("\n\n") }, ...replies];
    const last = all.at(-1)!;
    const snippet = (text: string) => text.replace(/\s+/g, " ").slice(0, 140);

    const [thread] = await db
      .insert(threads)
      .values({
        workspaceId: ws,
        mailboxId: mailbox.id,
        subject: seed.subject,
        normalizedSubject: normalize(seed.subject),
        snippet: snippet(last.body),
        participants: [theirs, ours],
        folder: seed.folder ?? "inbox",
        category: seed.category ?? "primary",
        important: seed.important ?? false,
        messageCount: all.length,
        assignedTo: seed.assigned === undefined ? null : teammateIds[seed.assigned]!,
        lastMessageAt: new Date(times.at(-1)!),
        trashedAt: seed.folder === "trash" ? new Date(firstAt) : null,
      })
      .returning();
    const threadId = thread!.id;

    const ids: string[] = [];
    await db.insert(messages).values(
      all.map((message, i) => {
        const inbound = message.dir === "in";
        const id = `<demo-${threadId}-${i}@${inbound ? seed.from[1].split("@")[1] : DOMAIN}>`;
        const references = [...ids];
        ids.push(id);
        const paragraphs = i === 0 ? seed.body : message.body.split("\n\n");
        return {
          workspaceId: ws,
          threadId,
          connectionId: connectionId,
          direction: inbound ? ("inbound" as const) : ("outbound" as const),
          providerMessageId: `demo-${threadId}-${i}`,
          messageIdHeader: id,
          inReplyTo: references.at(-1) ?? null,
          references,
          fromAddress: inbound ? theirs.address : ours.address,
          fromName: inbound ? theirs.name : (ours.name ?? null),
          toRecipients: [inbound ? ours : theirs],
          subject: i === 0 ? seed.subject : `Re: ${seed.subject.replace(/^re:\s*/i, "")}`,
          snippet: snippet(message.body),
          textBody: paragraphs.join("\n\n"),
          htmlBody: htmlOf(paragraphs, i === 0 && !!seed.html),
          rawSize: 2_000 + message.body.length,
          spamScore: seed.folder === "spam" ? 8.4 : 0.6,
          spamReasons: seed.folder === "spam" ? ["Looks like a prize or account scam", "Sender has no history with you"] : null,
          authentication: inbound ? { spf: "pass", dkim: seed.folder === "spam" ? "fail" : "pass", dmarc: seed.folder === "spam" ? "fail" : "pass" } : null,
          deliveryStatus: inbound ? null : "delivered",
          sentAt: new Date(times[i]!),
        };
      }),
    );

    await db.insert(threadUserState).values({
      threadId,
      userId: owner.id,
      readAt: seed.unread ? null : new Date(times.at(-1)!),
      starred: seed.starred ?? false,
    });
    if (seed.labels?.length) {
      await db.insert(threadLabels).values(seed.labels.map((name) => ({ threadId, labelId: label[name]! })));
    }
    if (seed.note) await db.insert(threadNotes).values({ threadId, userId: teammateIds[0]!, body: seed.note });
    count++;
  }

  const contactPeople = [...SEEDS.filter((s) => (s.category ?? "primary") === "primary" && s.folder !== "spam").map((s) => s.from)];
  const unique = [...new Map(contactPeople.map((p) => [p[1], p])).values()];
  await db.insert(contacts).values(
    unique.map(([name, address], i) => ({
      workspaceId: ws,
      email: address,
      firstName: name.split(" ")[0] ?? null,
      lastName: name.split(" ").slice(1).join(" ") || null,
      fields: { company: address.split("@")[1]!.split(".")[0]!.replace(/^./, (c) => c.toUpperCase()), plan: ["Solo", "Starter", "Team"][i % 3]! },
      unsubscribedAt: i % 11 === 10 ? new Date() : null,
    })),
  );

  return { workspaceId: ws, connectionId, mainDomainId: main!.id, conversations: count, contacts: unique.length, mailboxes: boxes };
}
