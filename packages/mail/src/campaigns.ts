import {
  campaignDeliveries,
  campaigns,
  connections,
  contacts,
  contactSegments,
  domains,
  getDb,
  mailboxes,
  suppressions,
  workspaces,
} from "@hellobox/db";
import { touchWorkspace } from "./activity";
import type { SesProvider } from "@hellobox/providers";
import { ResendApiError, type ResendClient } from "@hellobox/resend";
import { and, asc, eq, gt, inArray, isNull, not, or, sql } from "drizzle-orm";
import { clientForConnection, loadConnection, markIfRoleRevoked, sesProviderFor } from "./connections";
import { sanitizeEmailHtml } from "./sanitize";
import { isWorkspaceSuspended } from "./workspaces";
import {
  addUnsubscribeFooter,
  compileBroadcast,
  compileBroadcastSubject,
  renderSubject,
  renderTemplate,
  RESEND_UNSUBSCRIBE_TAG,
  TemplateError,
} from "./template";
import { oneClickUnsubscribeUrl, unsubscribeUrl } from "./unsubscribe";

const BATCH = 500;

type Contact = typeof contacts.$inferSelect;
type Segment = typeof contactSegments.$inferSelect;

export async function countContacts(workspaceId: string) {
  const [row] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(contacts)
    .where(eq(contacts.workspaceId, workspaceId));
  return row?.count ?? 0;
}

// Resend's broadcast merge tags print values as they are, so markup is taken out
// before a value leaves for Resend.
const plain = (value: string | null | undefined) => (value ? value.replace(/[<>]/g, "").trim() : null);

const isPending = or(isNull(contacts.syncedAt), gt(contacts.updatedAt, contacts.syncedAt));

// One Segment per connection holds the workspace's contacts. The advisory lock stops
// two jobs from creating two Segments for the same connection.
async function ensureSegment(connectionId: string, workspaceId: string, workspaceName: string) {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`segment:${connectionId}`}))`);
    const [existing] = await tx
      .select()
      .from(contactSegments)
      .where(eq(contactSegments.connectionId, connectionId));
    if (existing) return existing;
    const segment = await clientForConnection(connectionId).createSegment(
      `HelloBox: ${workspaceName}`.slice(0, 100),
    );
    const [created] = await tx
      .insert(contactSegments)
      .values({ workspaceId, connectionId, segmentId: segment.id })
      .returning();
    return created as Segment;
  });
}

async function activeSegments(workspaceId: string) {
  const db = getDb();
  const [workspace] = await db
    .select({ name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  if (!workspace) return [];
  // Segments are a Resend feature. Other providers read contacts straight from here.
  const linked = await db
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(
        eq(connections.workspaceId, workspaceId),
        eq(connections.status, "active"),
        eq(connections.provider, "resend"),
      ),
    );
  const segments: Segment[] = [];
  for (const connection of linked) {
    segments.push(await ensureSegment(connection.id, workspaceId, workspace.name));
  }
  return segments;
}

// Resend rejects properties it doesn't know, so each custom field is created first.
async function ensureProperties(client: ResendClient, segment: Segment, keys: Set<string>) {
  const missing = [...keys].filter((key) => !segment.propertyKeys.includes(key));
  if (!missing.length) return segment.propertyKeys;
  const remote = new Set(await client.listContactPropertyKeys());
  for (const key of missing) {
    if (!remote.has(key)) await client.createContactProperty(key);
  }
  const propertyKeys = [...segment.propertyKeys, ...missing];
  await getDb()
    .update(contactSegments)
    .set({ propertyKeys })
    .where(eq(contactSegments.id, segment.id));
  segment.propertyKeys = propertyKeys;
  return propertyKeys;
}

const notFound = (error: unknown) => error instanceof ResendApiError && error.status === 404;
// A bad address or value is the contact's problem, not the connection's, so the sync
// records it on the contact and moves on.
const contactProblem = (error: unknown) =>
  error instanceof ResendApiError && [400, 409, 422].includes(error.status);

async function pushContact(client: ResendClient, segment: Segment, contact: Contact) {
  const properties: Record<string, string | null> = {};
  for (const key of segment.propertyKeys) properties[key] = plain(contact.fields[key]);
  const fields = {
    first_name: plain(contact.firstName),
    last_name: plain(contact.lastName),
    ...(segment.propertyKeys.length ? { properties } : {}),
    // Only ever set, never cleared: an opt-out made on Resend's side has to stick.
    ...(contact.unsubscribedAt ? { unsubscribed: true } : {}),
  };
  try {
    await client.updateContact(contact.email, fields);
  } catch (error) {
    if (!notFound(error)) throw error;
    await client.createContact({ email: contact.email, ...fields, segments: [{ id: segment.segmentId }] });
    return;
  }
  try {
    await client.addContactToSegment(contact.email, segment.segmentId);
  } catch (error) {
    // Already in the segment.
    if (!contactProblem(error)) throw error;
  }
}

async function pushBatch(segments: Segment[], batch: Contact[]) {
  const errors = new Map<string, string>();
  for (const segment of segments) {
    const client = clientForConnection(segment.connectionId);
    const keys = new Set(batch.flatMap((contact) => Object.keys(contact.fields)));
    await ensureProperties(client, segment, keys);
    for (const contact of batch) {
      try {
        await pushContact(client, segment, contact);
      } catch (error) {
        if (!contactProblem(error)) throw error;
        errors.set(contact.id, (error as Error).message);
      }
    }
  }
  return errors;
}

// Pushes contacts to Resend: every contact to a connection that hasn't had them yet,
// then whatever changed since the last sync to all of them.
export async function syncContacts(workspaceId: string) {
  const db = getDb();
  const segments = await activeSegments(workspaceId);
  if (!segments.length) return { synced: 0 };

  for (const segment of segments.filter((candidate) => !candidate.fullSyncAt)) {
    const startedAt = new Date();
    let cursor = "";
    for (;;) {
      const batch = await db
        .select()
        .from(contacts)
        .where(and(eq(contacts.workspaceId, workspaceId), gt(contacts.id, cursor)))
        .orderBy(asc(contacts.id))
        .limit(BATCH);
      if (!batch.length) break;
      await pushBatch([segment], batch);
      cursor = batch[batch.length - 1]?.id ?? cursor;
    }
    await db.update(contactSegments).set({ fullSyncAt: startedAt }).where(eq(contactSegments.id, segment.id));
  }

  let synced = 0;
  let cursor = "";
  for (;;) {
    const batch = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.workspaceId, workspaceId), isPending, gt(contacts.id, cursor)))
      .orderBy(asc(contacts.id))
      .limit(BATCH);
    if (!batch.length) break;
    const errors = await pushBatch(segments, batch);
    for (const contact of batch) {
      // Matching on updatedAt means an edit made during the sync stays pending.
      await db
        .update(contacts)
        .set({ syncedAt: contact.updatedAt, updatedAt: contact.updatedAt, syncError: errors.get(contact.id) ?? null })
        .where(
          and(
            eq(contacts.id, contact.id),
            sql`date_trunc('milliseconds', ${contacts.updatedAt}) = ${contact.updatedAt.toISOString()}::timestamptz`,
          ),
        );
    }
    synced += batch.length;
    cursor = batch[batch.length - 1]?.id ?? cursor;
  }
  return { synced };
}

// Deleted contacts leave the workspace's segments. They stay in the Resend team,
// because other things there may use them.
export async function unsyncContacts(workspaceId: string, emails: string[]) {
  const stillHere = emails.length
    ? await getDb()
        .select({ email: contacts.email })
        .from(contacts)
        .where(and(eq(contacts.workspaceId, workspaceId), inArray(contacts.email, emails)))
    : [];
  const readded = new Set(stillHere.map((row) => row.email));
  const segments = await getDb()
    .select()
    .from(contactSegments)
    .where(eq(contactSegments.workspaceId, workspaceId));
  for (const segment of segments) {
    const client = clientForConnection(segment.connectionId);
    for (const email of emails) {
      if (readded.has(email)) continue;
      try {
        await client.removeContactFromSegment(email, segment.segmentId);
      } catch (error) {
        if (!notFound(error) && !contactProblem(error)) throw error;
      }
    }
  }
}

async function markUnsubscribed(workspaceId: string, emails: string[]) {
  if (!emails.length) return 0;
  const now = new Date();
  const updated = await getDb()
    .update(contacts)
    .set({ unsubscribedAt: now, updatedAt: now, syncedAt: now })
    .where(
      and(
        eq(contacts.workspaceId, workspaceId),
        inArray(contacts.email, emails),
        isNull(contacts.unsubscribedAt),
      ),
    )
    .returning({ id: contacts.id });
  return updated.length;
}

// People unsubscribe through Resend's link, so Resend is where opt-outs are first
// recorded. This copies them back before every send and from the webhook.
export async function pullOptOuts(segment: Segment) {
  const client = clientForConnection(segment.connectionId);
  let after: string | undefined;
  let count = 0;
  for (;;) {
    const page = await client.listSegmentContacts(segment.segmentId, after);
    const emails = page.data.filter((contact) => contact.unsubscribed).map((contact) => contact.email.toLowerCase());
    count += await markUnsubscribed(segment.workspaceId, emails);
    if (!page.has_more || !page.data.length) break;
    after = page.data[page.data.length - 1]?.id;
  }
  await getDb()
    .update(contactSegments)
    .set({ optOutsCheckedAt: new Date() })
    .where(eq(contactSegments.id, segment.id));
  return count;
}

export async function recordContactOptOut(connectionId: string, email: string) {
  const [connection] = await getDb()
    .select({ workspaceId: connections.workspaceId })
    .from(connections)
    .where(eq(connections.id, connectionId));
  if (connection) await markUnsubscribed(connection.workspaceId, [email.toLowerCase()]);
}

// A contact whose address bounced permanently or reported mail as spam. Campaigns leave
// them out and record how many, so the skip is never silent.
const isSuppressed = (workspaceId: string) =>
  sql`exists (select 1 from ${suppressions} where ${suppressions.workspaceId} = ${workspaceId} and ${suppressions.email} = lower(${contacts.email}))`;

async function countSuppressedContacts(workspaceId: string) {
  const [row] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(contacts)
    .where(and(eq(contacts.workspaceId, workspaceId), isNull(contacts.unsubscribedAt), isSuppressed(workspaceId)));
  return row?.count ?? 0;
}

const nobodyLeft = (suppressed: number) =>
  suppressed
    ? `None of your subscribed contacts can be sent to: ${suppressed} ${suppressed === 1 ? "is" : "are"} suppressed after a bounce or spam report`
    : "None of your contacts are subscribed";

const formatSender = (address: string, name: string | null) =>
  name ? `${name.replace(/["<>]/g, "")} <${address}>` : address;

export async function sendCampaign(campaignId: string) {
  const db = getDb();
  // Claiming from queued or sending lets a crashed attempt retry. The stored broadcast
  // id stops a retry from creating a second broadcast.
  const [campaign] = await db
    .update(campaigns)
    .set({ status: "sending", error: null })
    .where(and(eq(campaigns.id, campaignId), inArray(campaigns.status, ["queued", "sending"])))
    .returning();
  if (!campaign) return { status: "skipped" as const };
  const fail = async (error: string) => {
    await db.update(campaigns).set({ status: "failed", error }).where(eq(campaigns.id, campaignId));
    return { status: "failed" as const };
  };

  if (await isWorkspaceSuspended(campaign.workspaceId)) return fail("This workspace is suspended");
  if (!campaign.mailboxId) return fail("The mailbox this campaign was sending from was removed");
  const [sender] = await db
    .select({
      address: mailboxes.address,
      displayName: mailboxes.displayName,
      connectionId: domains.connectionId,
    })
    .from(mailboxes)
    .innerJoin(domains, eq(domains.id, mailboxes.domainId))
    .where(eq(mailboxes.id, campaign.mailboxId));
  if (!sender) return fail("The mailbox this campaign was sending from was removed");

  const from = formatSender(sender.address, sender.displayName);
  const connection = await loadConnection(sender.connectionId);
  if (connection.provider === "ses") {
    return sendWithSes({ campaign, sender, from, provider: sesProviderFor(connection), fail }).catch(async (error) => {
      await markIfRoleRevoked(connection.id, error);
      throw error;
    });
  }
  if (connection.provider !== "resend") return fail("Campaigns can't send through this provider yet");

  let html: string;
  let subject: string;
  try {
    html = addUnsubscribeFooter(
      sanitizeEmailHtml(compileBroadcast(campaign.html, campaign.values)),
      RESEND_UNSUBSCRIBE_TAG,
      from,
    );
    subject = compileBroadcastSubject(campaign.subject, campaign.values);
  } catch (error) {
    if (error instanceof TemplateError) return fail(error.message);
    throw error;
  }

  const client = clientForConnection(sender.connectionId);
  let broadcastId = campaign.broadcastId;
  if (!broadcastId) {
    await syncContacts(campaign.workspaceId);
    const [segment] = await db
      .select()
      .from(contactSegments)
      .where(eq(contactSegments.connectionId, sender.connectionId));
    if (!segment) return fail("This mailbox's Resend connection needs reconnecting");
    await pullOptOuts(segment);
    // Broadcasts go to the whole segment, so suppressed contacts leave it first. Removing
    // the suppression marks the contact changed, and the next sync adds it back.
    const held = await db
      .select({ email: contacts.email })
      .from(contacts)
      .where(and(eq(contacts.workspaceId, campaign.workspaceId), isNull(contacts.unsubscribedAt), isSuppressed(campaign.workspaceId)));
    for (const { email } of held) {
      try {
        await client.removeContactFromSegment(email, segment.segmentId);
      } catch (error) {
        if (!notFound(error) && !contactProblem(error)) throw error;
      }
    }
    const [counted] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(contacts)
      .where(
        and(
          eq(contacts.workspaceId, campaign.workspaceId),
          isNull(contacts.unsubscribedAt),
          isNull(contacts.syncError),
          not(isSuppressed(campaign.workspaceId)),
        ),
      );
    const recipients = counted?.count ?? 0;
    if (!recipients) return fail(nobodyLeft(held.length));
    const broadcast = await client.createBroadcast({
      segment_id: segment.segmentId,
      from,
      subject,
      html,
      name: campaign.name,
      reply_to: [sender.address],
    });
    broadcastId = broadcast.id;
    await db
      .update(campaigns)
      .set({ broadcastId, recipientCount: recipients, suppressedCount: held.length })
      .where(eq(campaigns.id, campaignId));
  }

  const remote = await client.getBroadcast(broadcastId);
  if (remote.status === "draft") await client.sendBroadcast(broadcastId);
  await db
    .update(campaigns)
    .set({ status: "sent", sentAt: new Date(), error: null })
    .where(eq(campaigns.id, campaignId));
  await touchWorkspace(campaign.workspaceId);
  return { status: "sent" as const, broadcastId };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const errorName = (error: unknown) => (error as { name?: string } | null)?.name ?? "";
const THROTTLED = ["TooManyRequestsException", "ThrottlingException", "LimitExceededException"];
// The account as a whole can't send. Waiting and retrying the job is the only option.
const ACCOUNT_BLOCKED = ["AccountSuspendedException", "SendingPausedException", "MailFromDomainNotVerifiedException"];

// SES has no broadcasts, so every recipient gets their own email, rendered with their
// own fields and unsubscribe link, paced to the account's send rate. A row per recipient
// makes this resumable: a retried job skips everyone who already has one.
async function sendWithSes(input: {
  campaign: typeof campaigns.$inferSelect;
  sender: { address: string };
  from: string;
  provider: SesProvider;
  fail: (error: string) => Promise<{ status: "failed" }>;
}) {
  const { campaign, sender, from, provider, fail } = input;
  const db = getDb();
  const eligible = and(
    eq(contacts.workspaceId, campaign.workspaceId),
    isNull(contacts.unsubscribedAt),
    not(isSuppressed(campaign.workspaceId)),
  );

  try {
    renderTemplate(campaign.html, { values: campaign.values });
    renderSubject(campaign.subject, { values: campaign.values });
  } catch (error) {
    if (error instanceof TemplateError) return fail(error.message);
    throw error;
  }

  const [counted] = await db.select({ count: sql<number>`count(*)::int` }).from(contacts).where(eligible);
  const total = counted?.count ?? 0;
  const [done] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(campaignDeliveries)
    .where(eq(campaignDeliveries.campaignId, campaign.id));
  const remaining = total - (done?.count ?? 0);
  if (!total) return fail(nobodyLeft(await countSuppressedContacts(campaign.workspaceId)));

  const account = await provider.accountStatus();
  if (!account.productionAccess) {
    return fail("Your Amazon SES account is still in the sandbox, so it can only send to verified addresses. Request production access in Settings.");
  }
  if (!account.sendingEnabled) return fail("Sending is paused on your Amazon SES account");
  if (remaining > account.max24HourSend - account.sentLast24Hours) {
    return fail(
      `Your Amazon SES account can send ${Math.max(0, account.max24HourSend - account.sentLast24Hours)} more emails today, and this campaign needs ${remaining}. Try again later or ask AWS for a higher quota.`,
    );
  }
  if (campaign.recipientCount === null) {
    await db
      .update(campaigns)
      .set({ recipientCount: total, suppressedCount: await countSuppressedContacts(campaign.workspaceId) })
      .where(eq(campaigns.id, campaign.id));
  }

  const interval = 1000 / Math.max(1, account.maxSendRate);
  let nextSendAt = Date.now();
  let cursor = "";
  for (;;) {
    const batch = await db
      .select()
      .from(contacts)
      .where(and(eligible, gt(contacts.id, cursor)))
      .orderBy(asc(contacts.id))
      .limit(BATCH);
    if (!batch.length) break;
    cursor = batch[batch.length - 1]?.id ?? cursor;

    for (const contact of batch) {
      const [claimed] = await db
        .insert(campaignDeliveries)
        .values({ campaignId: campaign.id, contactId: contact.id, email: contact.email })
        .onConflictDoNothing()
        .returning({ id: campaignDeliveries.id });
      // Already sent, failed, or cut off mid-send by a crash. A crash leaves it unknown
      // whether SES took the email, and a duplicate is worse than a gap.
      if (!claimed) continue;

      const link = unsubscribeUrl(contact.id);
      const data = {
        contact: { email: contact.email, first_name: contact.firstName, last_name: contact.lastName, fields: contact.fields },
        values: campaign.values,
        unsubscribeUrl: link,
      };
      let html: string;
      let subject: string;
      try {
        html = addUnsubscribeFooter(sanitizeEmailHtml(renderTemplate(campaign.html, data)), link, from);
        subject = renderSubject(campaign.subject, data);
      } catch (error) {
        await db
          .update(campaignDeliveries)
          .set({ status: "failed", error: (error as Error).message })
          .where(eq(campaignDeliveries.id, claimed.id));
        continue;
      }

      for (let attempt = 0; ; attempt += 1) {
        await sleep(Math.max(0, nextSendAt - Date.now()));
        nextSendAt = Math.max(Date.now(), nextSendAt) + interval;
        try {
          const sent = await provider.send({
            from,
            to: [contact.email],
            replyTo: [sender.address],
            subject,
            html,
            headers: {
              "List-Unsubscribe": `<${oneClickUnsubscribeUrl(contact.id)}>`,
              "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            },
            tags: { campaign: campaign.id },
          });
          await db
            .update(campaignDeliveries)
            .set({ status: "sent", providerMessageId: sent.id })
            .where(eq(campaignDeliveries.id, claimed.id));
          break;
        } catch (error) {
          if (THROTTLED.includes(errorName(error)) && attempt < 5) {
            nextSendAt = Date.now() + 1000 * 2 ** attempt;
            continue;
          }
          if (THROTTLED.includes(errorName(error)) || ACCOUNT_BLOCKED.includes(errorName(error))) {
            // Nothing went out, so this recipient is retried with the job.
            await db.delete(campaignDeliveries).where(eq(campaignDeliveries.id, claimed.id));
            throw error;
          }
          await db
            .update(campaignDeliveries)
            .set({ status: "failed", error: (error as Error).message })
            .where(eq(campaignDeliveries.id, claimed.id));
          break;
        }
      }
    }
  }

  await db
    .update(campaigns)
    .set({ status: "sent", sentAt: new Date(), error: null })
    .where(eq(campaigns.id, campaign.id));
  await touchWorkspace(campaign.workspaceId);
  return { status: "sent" as const };
}

// How far a per-recipient campaign has got.
export async function campaignProgress(campaignId: string) {
  const rows = await getDb()
    .select({ status: campaignDeliveries.status, count: sql<number>`count(*)::int` })
    .from(campaignDeliveries)
    .where(eq(campaignDeliveries.campaignId, campaignId))
    .groupBy(campaignDeliveries.status);
  const count = (status: string) => rows.find((row) => row.status === status)?.count ?? 0;
  return { sent: count("sent"), failed: count("failed"), sending: count("sending") };
}

// Workspaces with contacts waiting for Resend, for the maintenance job to pick up.
export async function workspacesWithPendingContacts() {
  const rows = await getDb()
    .selectDistinct({ workspaceId: contacts.workspaceId })
    .from(contacts)
    .where(isPending)
    .limit(100);
  return rows.map((row) => row.workspaceId);
}
