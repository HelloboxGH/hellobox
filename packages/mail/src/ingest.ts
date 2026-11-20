import { entitlementsFor, getExtensions } from "@hellobox/extensions";
import {
  attachments,
  domains,
  getDb,
  mailboxes,
  messages,
  connections,
  rules,
  senderLists,
  threadLabels,
  threads,
  threadUserState,
  webhookEvents,
  workspaces,
  type Address,
} from "@hellobox/db";
import type { InboundHint, ProviderKind } from "@hellobox/providers";
import {
  messageKey,
  objectSize,
  readObject,
  streamToStorage,
} from "@hellobox/storage";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { applyRules, categorize } from "./categorize";
import {
  markIfRoleRevoked,
  providerFor,
  providerForConnection,
  syncDomains,
} from "./connections";
import { receivingDomainIds } from "./domains";
import { shareWithAdmins } from "./mailbox-access";
import { publishEvent } from "./realtime";
import { sanitizeEmailHtml } from "./sanitize";
import { bounceBuckets, bounceDecision, claimBounce, sendBounce } from "./bounce";
import { assessInbound, QUARANTINE_HOURS, recordQuarantinedBytes } from "./flood";
import { isReportedSender, isSpamExempt, spamReportCount } from "./reputation";
import { classifySpam, SPAM_SCORE, senderPolicy } from "./spam";
import {
  domainOf,
  makeSnippet,
  matchesByFallback,
  normalizeSubject,
  parseAddress,
  parseAddressList,
  parseMessageIds,
  threadLookupIds,
} from "./threading";

const MAX_SCAN_BYTES = 15 * 1024 * 1024;

async function collectBytes(stream: ReadableStream<Uint8Array>) {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function copyToStorage(
  open: () => Promise<ReadableStream<Uint8Array>>,
  key: string,
  contentType: string,
) {
  await streamToStorage(key, await open(), contentType);
  return objectSize(key);
}

// What the webhook said about the email, for providers whose stored copy lacks it.
async function hintFor(connectionId: string, emailId: string): Promise<InboundHint> {
  const [event] = await getDb()
    .select({ payload: webhookEvents.payload })
    .from(webhookEvents)
    .where(and(eq(webhookEvents.connectionId, connectionId), eq(webhookEvents.emailId, emailId)))
    .limit(1);
  const hint = (event?.payload as { hint?: InboundHint } | undefined)?.hint;
  return hint ?? {};
}

// Where mail for a domain goes when no mailbox has the address. Each domain gets one, made
// the first time it's needed. It's hidden from mailbox lists and can't send, and only the
// owner and admins read it, in Spam. Mailboxes themselves are only ever made in settings.
export const unknownRecipientsAddress = (domain: string) => `*@${domain}`;

async function unknownRecipientsMailbox(workspaceId: string, domainId: string, domain: string) {
  const db = getDb();
  const address = unknownRecipientsAddress(domain);
  const created = await db
    .insert(mailboxes)
    .values({ workspaceId, domainId, address, isCatchAll: true, displayName: "Unknown recipients" })
    .onConflictDoNothing()
    .returning({ id: mailboxes.id });
  await shareWithAdmins(workspaceId, created.map((row) => row.id));
  const [mailbox] = await db
    .select()
    .from(mailboxes)
    .where(and(eq(mailboxes.workspaceId, workspaceId), eq(mailboxes.address, address)));
  return mailbox ?? null;
}

// Resolves the mailbox from the recipients. Mail for an address with no mailbox isn't
// given one: it goes to the domain's unknown-recipients mailbox, and ingest keeps it in
// Spam and bounces it when that's safe.
async function resolveMailbox(
  connectionId: string,
  workspaceId: string,
  allRecipients: string[],
  provider: ProviderKind,
) {
  const db = getDb();
  const mail = getExtensions().mail;
  // A kind with mailboxes of its own (the public demo's sandboxes) says which one takes this mail.
  const own = await mail?.ownMailbox?.({ provider, workspaceId, recipients: allRecipients });
  if (own) return own.mailbox ? { mailbox: own.mailbox as typeof mailboxes.$inferSelect, unknownRecipient: null } : null;
  // Some addresses (demo ones) belong to their sandbox alone: another connection on the same
  // domain never takes mail for one.
  const recipients = allRecipients.filter((address) => !mail?.ignoreRecipient?.(address, provider));
  const findDomains = () =>
    db.select().from(domains).where(eq(domains.connectionId, connectionId));
  let known = await findDomains();
  const ours = (rows: typeof known) =>
    recipients.filter((address) => rows.some((domain) => domain.name === domainOf(address)));
  let addresses = ours(known);
  if (!addresses.length) {
    await syncDomains(connectionId, workspaceId, (await entitlementsFor(workspaceId)).limits.domains);
    known = await findDomains();
    addresses = ours(known);
  }
  if (!addresses.length) return null;
  // Only a domain that takes new mail here counts (see receivesMail): a removed one, or one
  // that another place has on, gets nothing, wherever the mailbox is.
  const matching = known.filter((domain) => addresses.some((address) => domainOf(address) === domain.name));
  const receiving = await receivingDomainIds(matching);
  known = matching.filter((domain) => receiving.has(domain.id));
  addresses = ours(known);
  if (!addresses.length) return { refused: true as const };

  // The first recipient that has a mailbox wins. A deleted mailbox doesn't count: its row
  // only keeps its old conversations, so new mail to it is treated like any address with no
  // mailbox. Adding the address again in settings brings the mailbox back.
  const existing = await db
    .select()
    .from(mailboxes)
    .where(
      and(
        eq(mailboxes.workspaceId, workspaceId),
        inArray(mailboxes.address, addresses),
        eq(mailboxes.isCatchAll, false),
        isNull(mailboxes.removedAt),
      ),
    );
  for (const address of addresses) {
    const mailbox = existing.find((row) => row.address === address);
    if (mailbox) return { mailbox, unknownRecipient: null };
  }

  const address = addresses[0] as string;
  const domain = known.find((row) => row.name === domainOf(address));
  if (!domain) return null;
  const holder = await unknownRecipientsMailbox(workspaceId, domain.id, domain.name);
  return holder ? { mailbox: holder, unknownRecipient: { address, domain } } : null;
}

export async function findThreadFor(input: {
  mailboxId: string;
  workspaceId: string;
  inReplyTo: string | null;
  references: string[];
  subject: string;
  participants: string[];
  sentAt: Date;
}) {
  const db = getDb();
  const ids = threadLookupIds(input.inReplyTo, input.references);
  if (ids.length) {
    const related = await db
      .select({ threadId: messages.threadId, header: messages.messageIdHeader })
      .from(messages)
      .innerJoin(threads, eq(threads.id, messages.threadId))
      .where(
        and(
          eq(messages.workspaceId, input.workspaceId),
          eq(threads.mailboxId, input.mailboxId),
          inArray(messages.messageIdHeader, ids),
        ),
      );
    for (const id of ids) {
      const hit = related.find((row) => row.header === id);
      if (hit) return hit.threadId;
    }
  }
  const candidates = await db
    .select()
    .from(threads)
    .where(
      and(
        eq(threads.mailboxId, input.mailboxId),
        eq(threads.normalizedSubject, normalizeSubject(input.subject)),
      ),
    )
    .orderBy(desc(threads.lastMessageAt))
    .limit(5);
  return (
    candidates.find((thread) =>
      matchesByFallback(
        {
          subject: input.subject,
          participants: input.participants,
          sentAt: input.sentAt,
        },
        thread,
      ),
    )?.id ?? null
  );
}

export function mergeParticipants(current: Address[], incoming: Address[]) {
  const merged = new Map(current.map((p) => [p.address, p]));
  for (const person of incoming) {
    if (!merged.get(person.address)?.name) merged.set(person.address, person);
  }
  return [...merged.values()].slice(0, 50);
}

// Safe to run repeatedly: the unique message index stops duplicates, and every
// step before the insert writes to deterministic storage keys.
export async function ingestEmail(connectionId: string, emailId: string) {
  const db = getDb();
  const [row] = await db
    .select({ connection: connections, bouncesEnabled: workspaces.bouncesEnabled })
    .from(connections)
    .innerJoin(workspaces, eq(workspaces.id, connections.workspaceId))
    .where(eq(connections.id, connectionId));
  if (!row) return { status: "no-connection" as const };
  const { connection } = row;
  const { workspaceId } = connection;

  const [existing] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.connectionId, connectionId),
        eq(messages.providerMessageId, emailId),
      ),
    );
  const provider = providerFor(connection);
  if (existing) {
    await cleanUp(connectionId, emailId, provider.afterIngest?.bind(provider));
    return { status: "duplicate" as const };
  }

  const email = await provider
    .fetchInbound(emailId, await hintFor(connectionId, emailId))
    .catch(async (error) => {
      await markIfRoleRevoked(connectionId, error);
      throw error;
    });
  const recipients = [...email.recipients, ...email.to, ...email.cc].map(
    (value) => parseAddress(value).address,
  );
  const resolved = await resolveMailbox(
    connectionId,
    workspaceId,
    recipients,
    connection.provider,
  );
  if (!resolved) return { status: "no-mailbox" as const };
  if ("refused" in resolved) {
    // Nothing is stored, so nobody here ever sees it.
    await db
      .update(webhookEvents)
      .set({ processedAt: new Date() })
      .where(and(eq(webhookEvents.connectionId, connectionId), eq(webhookEvents.emailId, emailId)));
    await cleanUp(connectionId, emailId, provider.afterIngest?.bind(provider));
    return { status: "not-receiving" as const };
  }
  const { mailbox, unknownRecipient } = resolved;
  const from = parseAddress(email.from);

  // Before anything is stored: a flood mustn't cost the workspace storage, or us much.
  const flood = await assessInbound({ workspaceId, fromAddress: from.address, unknownRecipient: Boolean(unknownRecipient) });
  if (flood.kind === "drop") {
    console.warn(`[ingest] Dropped ${emailId} for workspace ${workspaceId}: ${flood.reason}`);
    await db
      .update(webhookEvents)
      .set({ processedAt: new Date() })
      .where(and(eq(webhookEvents.connectionId, connectionId), eq(webhookEvents.emailId, emailId)));
    await cleanUp(connectionId, emailId, provider.afterIngest?.bind(provider));
    return { status: "dropped" as const };
  }
  // Kept in Spam for a day, uncounted, then deleted unless someone keeps it.
  const quarantined = flood.kind === "quarantine";

  const messageId = crypto.randomUUID();
  const to = parseAddressList(email.to);
  const cc = parseAddressList(email.cc);
  const sentAt = email.sentAt;
  const references = parseMessageIds(email.headers.references);
  const inReplyTo = parseMessageIds(email.headers["in-reply-to"])[0] ?? null;
  const subject = email.subject;

  // Files first, so that a failed download retries before anything is visible.
  let rawKey: string | null = null;
  let rawSize = 0;
  let scanBytes: Uint8Array | null = null;
  if (email.raw) {
    rawKey = messageKey(workspaceId, emailId, "raw.eml");
    rawSize = await copyToStorage(email.raw.open, rawKey, "message/rfc822");
    if (rawSize <= MAX_SCAN_BYTES) scanBytes = await collectBytes(await readObject(rawKey));
  }

  const stored: (typeof attachments.$inferInsert)[] = [];
  // The original counts too: it's a separate copy of the whole email in storage.
  let storedBytes = rawSize;
  for (const attachment of email.attachments) {
    const storageKey = messageKey(workspaceId, emailId, attachment.id);
    const size = await copyToStorage(attachment.open, storageKey, attachment.contentType);
    storedBytes += size;
    stored.push({
      workspaceId,
      messageId,
      providerAttachmentId: attachment.id,
      filename: attachment.filename,
      contentType: attachment.contentType,
      size,
      contentId: attachment.contentId,
      disposition: attachment.disposition,
      storageKey,
    });
  }

  const [senderEntries, workspaceRules, reports, exempt] = await Promise.all([
    db.select().from(senderLists).where(eq(senderLists.workspaceId, workspaceId)),
    db
      .select()
      .from(rules)
      .where(and(eq(rules.workspaceId, workspaceId), eq(rules.enabled, true)))
      .orderBy(rules.priority),
    spamReportCount(from.address),
    unknownRecipient ? false : isSpamExempt(mailbox.id, from.address),
  ]);
  const verdict = await classifySpam({
    raw: scanBytes,
    policy: senderPolicy(from.address, senderEntries),
    authentication: email.authentication,
    attachmentNames: stored.map((a) => a.filename),
    unknownRecipient: Boolean(unknownRecipient),
    flood: flood.kind === "quarantine" && !unknownRecipient,
    exempt,
    reported: isReportedSender(reports),
  });
  const action = applyRules(workspaceRules, {
    fromAddress: from.address,
    to: to.map((p) => p.address),
    subject,
  });
  const category =
    action.category ??
    categorize({
      fromAddress: from.address,
      subject,
      headers: email.headers,
      html: email.html,
    }).category;
  const folder = verdict.isSpam ? "spam" : (action.folder ?? "inbox");
  const participants = [from, ...to, ...cc];
  const snippet = makeSnippet(email.text, email.html);

  const threadId = await db.transaction(async (tx) => {
    // Quarantined mail never joins a conversation: it expires on its own, and mustn't take
    // a real conversation with it or be kept alive by it.
    const found = quarantined ? null : await findThreadFor({
      mailboxId: mailbox.id,
      workspaceId,
      inReplyTo,
      references,
      subject,
      participants: participants.map((p) => p.address),
      sentAt,
    });
    let id = found;
    if (id) {
      const [thread] = await tx.select().from(threads).where(eq(threads.id, id));
      await tx
        .update(threads)
        .set({
          snippet,
          participants: mergeParticipants(thread?.participants ?? [], participants),
          lastMessageAt: sql`greatest(${threads.lastMessageAt}, ${sentAt.toISOString()}::timestamptz)`,
          messageCount: sql`${threads.messageCount} + 1`,
          hasAttachments: sql`${threads.hasAttachments} or ${stored.length > 0}`,
          // A new reply brings an archived conversation back, but spam stays put.
          folder:
            thread?.folder === "archive" && folder === "inbox"
              ? "inbox"
              : (thread?.folder ?? folder),
        })
        .where(eq(threads.id, id));
    } else {
      const [created] = await tx
        .insert(threads)
        .values({
          workspaceId,
          mailboxId: mailbox.id,
          subject,
          normalizedSubject: normalizeSubject(subject),
          snippet,
          participants: mergeParticipants([], participants),
          folder,
          category,
          hasAttachments: stored.length > 0,
          messageCount: 1,
          lastMessageAt: sentAt,
          expiresAt: quarantined ? new Date(Date.now() + QUARANTINE_HOURS * 3_600_000) : null,
        })
        .returning({ id: threads.id });
      id = created?.id ?? null;
    }
    if (!id) throw new Error("Could not create a thread");

    const [inserted] = await tx
      .insert(messages)
      .values({
        id: messageId,
        workspaceId,
        threadId: id,
        connectionId,
        direction: "inbound",
        providerMessageId: emailId,
        messageIdHeader: email.messageId,
        inReplyTo,
        references,
        fromAddress: from.address,
        fromName: from.name,
        toRecipients: to,
        ccRecipients: cc,
        replyTo: email.replyTo,
        subject,
        snippet,
        textBody: email.text,
        htmlBody: email.html ? sanitizeEmailHtml(email.html) : null,
        rawKey,
        rawSize,
        storageCounted: !quarantined,
        spamScore: verdict.score,
        spamSymbols: verdict.symbols,
        spamReasons: verdict.reasons,
        unscanned: verdict.unscanned,
        authentication: email.authentication ?? null,
        sentAt,
      })
      .onConflictDoNothing()
      .returning({ id: messages.id });
    if (!inserted) {
      // Lost a race with a parallel job. Rolling back undoes the thread changes.
      throw new DuplicateMessage();
    }
    if (stored.length) await tx.insert(attachments).values(stored);
    if (action.labelId) {
      await tx
        .insert(threadLabels)
        .values({ threadId: id, labelId: action.labelId })
        .onConflictDoNothing();
    }
    // A new message makes the conversation unread again for everyone.
    await tx
      .update(threadUserState)
      .set({ readAt: null, snoozedUntil: null })
      .where(eq(threadUserState.threadId, id));
    if (!quarantined) {
      await tx
        .update(workspaces)
        .set({
          storageBytesUsed: sql`${workspaces.storageBytesUsed} + ${storedBytes}`,
        })
        .where(eq(workspaces.id, workspaceId));
    }
    await tx
      .update(webhookEvents)
      .set({ processedAt: new Date() })
      .where(
        and(
          eq(webhookEvents.connectionId, connectionId),
          eq(webhookEvents.emailId, emailId),
        ),
      );
    return id;
  }).catch((error) => {
    if (error instanceof DuplicateMessage) return null;
    throw error;
  });

  await cleanUp(connectionId, emailId, provider.afterIngest?.bind(provider));
  if (!threadId) return { status: "duplicate" as const };
  if (quarantined) await recordQuarantinedBytes(workspaceId, storedBytes);
  // Bounces are opt-in per workspace. Settings and onboarding explain the risks.
  if (unknownRecipient && row.bouncesEnabled) {
    // Mail that would be spam even at a real mailbox gets no bounce.
    const policy = senderPolicy(from.address, senderEntries);
    const decision = bounceDecision({
      from: email.from,
      headers: email.headers,
      authentication: email.authentication,
      looksLikeSpam:
        policy.blocked ||
        isReportedSender(reports) ||
        (verdict.score ?? 0) >= SPAM_SCORE / 2 ||
        email.authentication?.dmarc === "fail" ||
        action.folder === "spam",
      sendingEnabled: unknownRecipient.domain.sendingEnabled,
    });
    const full = decision.send
      ? await claimBounce(bounceBuckets({ to: decision.to, domainId: unknownRecipient.domain.id, workspaceId }))
      : null;
    if (full) console.warn(`[ingest] Bounce limit reached (${full.replace(/:[^:]+$/, "")}), not bouncing`);
    if (decision.send && !full) {
      await sendBounce(provider, {
        to: decision.to,
        recipient: unknownRecipient.address,
        subject,
        sentAt,
        messageId: email.messageId,
        idempotencyKey: `bounce-${messageId}`,
      });
    }
  }
  await publishEvent(workspaceId, { type: "thread.updated", threadId });
  return { status: "ingested" as const, threadId, messageId };
}

class DuplicateMessage extends Error {}

// The email is in our storage now, so the provider's copy can go. Failing here isn't
// fatal: the bucket expires leftovers and backfill skips mail we already have.
async function cleanUp(
  connectionId: string,
  emailId: string,
  afterIngest: ((id: string) => Promise<void>) | undefined,
) {
  if (!afterIngest) return;
  await afterIngest(emailId).catch((error) =>
    console.error(`[ingest] Couldn't clear ${emailId} for ${connectionId}:`, error),
  );
}

// Fills gaps from outages, walking back until a page contains only known mail.
export async function backfillConnection(
  connectionId: string,
  enqueue: (emailId: string) => Promise<unknown>,
) {
  const db = getDb();
  const provider = await providerForConnection(connectionId);
  let next: string | undefined;
  for (let page = 0; page < 5; page += 1) {
    const { ids, next: following } = await provider.listInbound(next).catch(async (error) => {
      await markIfRoleRevoked(connectionId, error);
      throw error;
    });
    if (!ids.length) break;
    const known = await db
      .select({ id: messages.providerMessageId })
      .from(messages)
      .where(
        and(
          eq(messages.connectionId, connectionId),
          inArray(messages.providerMessageId, ids),
        ),
      );
    const knownIds = new Set(known.map((row) => row.id));
    const missing = ids.filter((id) => !knownIds.has(id));
    await Promise.all(missing.map(enqueue));
    if (!missing.length || !following) break;
    next = following;
  }
  await db
    .update(connections)
    .set({ lastBackfillAt: new Date() })
    .where(eq(connections.id, connectionId));
}
