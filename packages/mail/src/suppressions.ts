import { campaignDeliveries, campaigns, connections, contacts, getDb, suppressions } from "@hellobox/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

export type SuppressionReason = "bounce" | "complaint";

// Adds addresses after a permanent bounce or a complaint. Seeing one again updates its
// reason and source, so the list always shows the latest.
export async function addSuppressions(input: {
  workspaceId: string;
  emails: string[];
  reason: SuppressionReason;
  detail?: string;
  connectionId?: string;
  messageId?: string | null;
  campaignId?: string | null;
  providerMessageId?: string;
}) {
  const emails = [...new Set(input.emails.map((email) => email.trim().toLowerCase()).filter(Boolean))];
  if (!emails.length) return;
  const source = {
    reason: input.reason,
    detail: input.detail?.slice(0, 1000) ?? null,
    connectionId: input.connectionId ?? null,
    messageId: input.messageId ?? null,
    campaignId: input.campaignId ?? null,
    providerMessageId: input.providerMessageId ?? null,
  };
  await getDb()
    .insert(suppressions)
    .values(emails.map((email) => ({ workspaceId: input.workspaceId, email, ...source })))
    .onConflictDoUpdate({
      target: [suppressions.workspaceId, suppressions.email],
      set: { ...source, updatedAt: new Date() },
    });
}

// Records the suppressions a delivery event calls for, finding the workspace from the
// connection and the campaign from the send, when it was one.
export async function suppressFromEvent(input: {
  connectionId: string;
  providerMessageId: string;
  messageId: string | null;
  emails: string[];
  reason: SuppressionReason;
  detail?: string;
}) {
  const db = getDb();
  const [connection] = await db
    .select({ workspaceId: connections.workspaceId })
    .from(connections)
    .where(eq(connections.id, input.connectionId));
  if (!connection) return;
  const [send] = input.messageId
    ? []
    : await db
        .select({ campaignId: campaignDeliveries.campaignId })
        .from(campaignDeliveries)
        .innerJoin(campaigns, eq(campaigns.id, campaignDeliveries.campaignId))
        .where(and(eq(campaignDeliveries.providerMessageId, input.providerMessageId), eq(campaigns.workspaceId, connection.workspaceId)))
        .limit(1);
  await addSuppressions({
    workspaceId: connection.workspaceId,
    emails: input.emails,
    reason: input.reason,
    detail: input.detail,
    connectionId: input.connectionId,
    messageId: input.messageId,
    campaignId: send?.campaignId ?? null,
    providerMessageId: input.providerMessageId,
  });
}

const bare = (value: string) => (value.match(/<([^>]+)>/)?.[1] ?? value).trim().toLowerCase();

// Which of these addresses the workspace doesn't send to, and why.
export async function suppressedAmong(workspaceId: string, addresses: string[]) {
  const emails = [...new Set(addresses.map(bare).filter(Boolean))];
  if (!emails.length) return [];
  return getDb()
    .select({ email: suppressions.email, reason: suppressions.reason, detail: suppressions.detail, createdAt: suppressions.createdAt })
    .from(suppressions)
    .where(and(eq(suppressions.workspaceId, workspaceId), inArray(suppressions.email, emails)));
}

export async function listSuppressions(workspaceId: string) {
  return getDb()
    .select({
      id: suppressions.id,
      email: suppressions.email,
      reason: suppressions.reason,
      detail: suppressions.detail,
      messageId: suppressions.messageId,
      campaignId: suppressions.campaignId,
      // Which provider reported it. Null once that connection is deleted.
      provider: connections.provider,
      createdAt: suppressions.createdAt,
      updatedAt: suppressions.updatedAt,
    })
    .from(suppressions)
    .leftJoin(connections, eq(connections.id, suppressions.connectionId))
    .where(eq(suppressions.workspaceId, workspaceId))
    .orderBy(desc(suppressions.updatedAt))
    .limit(1000);
}

// Lets mail go to the address again. Its contact is marked changed, so the next sync puts
// it back in the workspace's Resend segments.
export async function removeSuppression(workspaceId: string, id: string) {
  const db = getDb();
  const [removed] = await db
    .delete(suppressions)
    .where(and(eq(suppressions.id, id), eq(suppressions.workspaceId, workspaceId)))
    .returning({ email: suppressions.email, reason: suppressions.reason });
  if (!removed) return null;
  await db
    .update(contacts)
    .set({ updatedAt: sql`now()` })
    .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.email, removed.email)));
  return removed;
}
