import {
  attachments,
  domains,
  getDb,
  mailboxes,
  messages,
  outbox,
  threads,
  uploads,
} from "@hellobox/db";
import { touchWorkspace } from "./activity";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { markIfRoleRevoked, providerForConnection } from "./connections";
import { bodyColumns, sealingKeysForMailbox } from "./encryption";
import { deliveryStatusFor, mergeDelivery, summarizeDelivery, suppressionReason } from "./delivery";
import { suppressFromEvent } from "./suppressions";
import { isWorkspaceSuspended } from "./workspaces";

import { mergeParticipants } from "./store-inbound";
import { publishEvent } from "./realtime";
import { supportMessageAdded } from "./support/read";
import {
  domainOf,
  makeSnippet,
  normalizeSubject,
  parseAddress,
} from "./threading";

// A message from an app has no Message-ID to answer, so the reply points at the latest
// email in the conversation that one of its recipients has. Without it, their mail client
// would start a new conversation.
async function earlierEmail(threadId: string, item: { toRecipients: string[]; ccRecipients: string[] }) {
  const recipients = new Set([...item.toRecipients, ...item.ccRecipients].map((value) => parseAddress(value).address));
  const emails = await getDb()
    .select({
      direction: messages.direction,
      messageIdHeader: messages.messageIdHeader,
      references: messages.references,
      fromAddress: messages.fromAddress,
      toRecipients: messages.toRecipients,
      ccRecipients: messages.ccRecipients,
    })
    .from(messages)
    .where(and(eq(messages.threadId, threadId), isNotNull(messages.messageIdHeader)))
    .orderBy(desc(messages.sentAt))
    .limit(100);
  return emails.find(
    (email) =>
      (email.direction === "inbound" && recipients.has(email.fromAddress)) ||
      [...email.toRecipients, ...email.ccRecipients].some((person) => recipients.has(person.address)),
  );
}

export async function sendOutbox(outboxId: string) {
  const db = getDb();
  // Claiming from scheduled or sending lets a crashed attempt retry. Resend's
  // Idempotency-Key stops that retry from sending the email twice. SES has none, so a
  // crash between SES accepting the email and the row below can repeat it.
  const [item] = await db
    .update(outbox)
    .set({ status: "sending", error: null })
    .where(
      and(eq(outbox.id, outboxId), inArray(outbox.status, ["scheduled", "sending"])),
    )
    .returning();
  if (!item) return { status: "skipped" as const };
  if (await isWorkspaceSuspended(item.workspaceId)) {
    await db.update(outbox).set({ status: "failed", error: "This workspace is suspended" }).where(eq(outbox.id, item.id));
    return { status: "failed" as const };
  }

  const [row] = await db
    .select({
      address: mailboxes.address,
      displayName: mailboxes.displayName,
      connectionId: domains.connectionId,
    })
    .from(mailboxes)
    .innerJoin(domains, eq(domains.id, mailboxes.domainId))
    .where(eq(mailboxes.id, item.mailboxId));
  if (!row) throw new Error("Mailbox not found");

  const parent = item.replyToMessageId
    ? (
        await db
          .select()
          .from(messages)
          .where(eq(messages.id, item.replyToMessageId))
      )[0]
    : undefined;
  const answered = parent?.messageIdHeader ? parent : parent && (await earlierEmail(parent.threadId, item));
  const references = answered?.messageIdHeader ? [...answered.references, answered.messageIdHeader] : (parent?.references ?? []);
  const messageIdHeader = `<${item.id}@${domainOf(row.address)}>`;
  const headers: Record<string, string> = { "Message-ID": messageIdHeader };
  if (answered?.messageIdHeader) headers["In-Reply-To"] = answered.messageIdHeader;
  if (references.length) headers.References = references.join(" ");
  // Lets anyone reading the raw message see that an agent sent it for the user.
  if (item.agentTokenId) headers["X-HelloBox-Sent-By"] = "agent";

  const files = item.uploadIds.length
    ? await db
        .select()
        .from(uploads)
        .where(
          and(
            inArray(uploads.id, item.uploadIds),
            eq(uploads.workspaceId, item.workspaceId),
          ),
        )
    : [];
  if (files.some((file) => file.status === "pending")) {
    throw new Error("An attachment has not finished uploading");
  }
  const from = row.displayName
    ? `${row.displayName.replace(/["<>]/g, "")} <${row.address}>`
    : row.address;
  const provider = await providerForConnection(row.connectionId);
  const sent = await provider
    .send(
      {
        from,
        to: item.toRecipients,
        cc: item.ccRecipients,
        bcc: item.bccRecipients,
        subject: item.subject,
        html: item.html,
        headers,
        attachments: files.map((file) => ({
          filename: file.filename,
          contentType: file.contentType,
          storageKey: file.storageKey,
        })),
        tags: { outbox: item.id },
      },
      item.id,
    )
    .catch(async (error) => {
      await markIfRoleRevoked(row.connectionId, error);
      throw error;
    });
  const providerMessageId = sent.id;
  const storedMessageId = sent.messageIdHeader ?? messageIdHeader;

  const to = item.toRecipients.map(parseAddress);
  const cc = item.ccRecipients.map(parseAddress);
  const bcc = item.bccRecipients.map(parseAddress);
  const participants = [{ address: row.address }, ...to, ...cc];
  // Sent mail in an encrypted mailbox is stored sealed too.
  const sealingKeys = await sealingKeysForMailbox(item.mailboxId);
  const snippet = sealingKeys ? "" : makeSnippet(null, item.html);
  const body = await bodyColumns({ text: null, html: item.html }, sealingKeys);
  const now = new Date();

  const threadId = await db.transaction(async (tx) => {
    let threadId = item.threadId;
    if (threadId) {
      const [thread] = await tx.select().from(threads).where(eq(threads.id, threadId));
      await tx
        .update(threads)
        .set({
          snippet,
          participants: mergeParticipants(thread?.participants ?? [], participants),
          lastMessageAt: now,
          messageCount: sql`${threads.messageCount} + 1`,
          hasAttachments: sql`${threads.hasAttachments} or ${files.length > 0}`,
        })
        .where(eq(threads.id, threadId));
    } else {
      const [created] = await tx
        .insert(threads)
        .values({
          workspaceId: item.workspaceId,
          mailboxId: item.mailboxId,
          subject: item.subject,
          normalizedSubject: normalizeSubject(item.subject),
          snippet,
          participants: mergeParticipants([], participants),
          folder: "archive",
          hasAttachments: files.length > 0,
          messageCount: 1,
          lastMessageAt: now,
        })
        .returning({ id: threads.id });
      threadId = created?.id ?? null;
    }
    if (!threadId) throw new Error("Could not create a thread");

    const [message] = await tx
      .insert(messages)
      .values({
        workspaceId: item.workspaceId,
        threadId,
        connectionId: row.connectionId,
        direction: "outbound",
        providerMessageId,
        messageIdHeader: storedMessageId,
        inReplyTo: answered?.messageIdHeader ?? null,
        references,
        fromAddress: row.address,
        fromName: row.displayName,
        toRecipients: to,
        ccRecipients: cc,
        bccRecipients: bcc,
        subject: item.subject,
        snippet,
        ...body,
        deliveryStatus: "sent",
        agentTokenId: item.agentTokenId,
        sentByUserId: item.userId,
        sentAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: messages.id });
    // A reply in a support conversation reaches the customer's app too. The email went out
    // already, so a problem here never undoes storing it.
    if (message) {
      await tx
        .transaction((savepoint) =>
          supportMessageAdded(savepoint, threadId, { id: message.id, direction: "outbound", fromAddress: row.address, toRecipients: to, ccRecipients: cc, sentAt: now }),
        )
        .catch((error: unknown) => console.error("[support] Couldn't record a reply for the app:", error));
    }
    // The uploaded files become the sent message's attachments, so they can be
    // opened from Sent and are freed along with the conversation.
    if (message && files.length) {
      await tx.insert(attachments).values(
        files.map((file) => ({
          workspaceId: item.workspaceId,
          messageId: message.id,
          filename: file.filename,
          contentType: file.contentType,
          size: file.size,
          disposition: "attachment",
          storageKey: file.storageKey,
        })),
      );
    }

    await tx
      .update(outbox)
      .set({
        status: "sent",
        // The queued copy is plaintext. Once sent, the sealed message is the only copy.
        ...(sealingKeys ? { html: "" } : {}),
        providerMessageId,
        messageId: message?.id ?? null,
        threadId,
      })
      .where(eq(outbox.id, item.id));
    return threadId;
  });
  await publishEvent(item.workspaceId, { type: "thread.updated", threadId });
  await touchWorkspace(item.workspaceId);
  return { status: "sent" as const, threadId };
}

export const DELIVERY_EVENTS = [
  "email.delivered",
  "email.bounced",
  "email.complained",
  "email.failed",
  "email.delivery_delayed",
];

// Updates a sent email's delivery by recipient, keeping the provider's reason, and adds
// the addresses a permanent bounce or a complaint names to the suppression list.
export async function recordDeliveryEvent(
  connectionId: string,
  type: string,
  emailId: string,
  detail: { recipients?: string[]; reason?: string } = {},
) {
  const status = deliveryStatusFor(type);
  if (!status) return;
  const recipients = detail.recipients ?? [];
  const messageId = await getDb().transaction(async (tx) => {
    const [row] = await tx
      .select({ id: messages.id, deliveryRecipients: messages.deliveryRecipients })
      .from(messages)
      .where(and(eq(messages.connectionId, connectionId), eq(messages.providerMessageId, emailId)))
      .for("update");
    if (!row) return null;
    const merged = mergeDelivery(row.deliveryRecipients, status, recipients, detail.reason, new Date());
    await tx
      .update(messages)
      .set({ deliveryRecipients: merged, deliveryStatus: summarizeDelivery(merged) })
      .where(eq(messages.id, row.id));
    return row.id;
  });
  const reason = suppressionReason(type);
  if (!reason || !recipients.length) return;
  await suppressFromEvent({ connectionId, providerMessageId: emailId, messageId, emails: recipients, reason, detail: detail.reason });
}

