import { randomBytes } from "node:crypto";
import { decrypt, encrypt } from "@hellobox/config";
import { getDb, supportInboxes, supportWebhookEvents } from "@hellobox/db";
import { enqueueSupportWebhook } from "@hellobox/queue";
import { and, asc, eq, gt, isNull, lt, lte, min, sql } from "drizzle-orm";
import { signWebhook } from "../notifications/channels";
import { postToPublicUrl } from "../safe-url";
import type { StoreTx } from "../store-inbound";

// Events about verified conversations, for the developer's server. They carry ids only: the
// app asks the API for the rest, which checks what the customer may see.

export type SupportEventType = "message.created" | "conversation.status_changed";

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const BATCH = 20;
const CLAIM_MS = 2 * 60 * 1000;
const backoff = (failures: number) => Math.min(30_000 * 2 ** Math.max(0, failures - 1), 60 * 60 * 1000);

export const generateWebhookSecret = () => `whsec_${randomBytes(24).toString("base64url")}`;
export const sealWebhookSecret = (secret: string) => encrypt(secret);

let enqueue = enqueueSupportWebhook;
/** For tests: what happens instead of queueing a delivery. */
export const setSupportWebhookEnqueue = (next: typeof enqueueSupportWebhook) => {
  enqueue = next;
};

const queueDelivery = (inboxId: string, delayMs = 0) =>
  enqueue(inboxId, delayMs).catch((error: unknown) => console.error("[support] Couldn't queue a webhook, maintenance will:", error));

/**
 * Records an event in the transaction that made it happen, when the conversation is
 * verified and its inbox has a webhook. Delivery is queued a moment later, after the commit.
 */
export async function recordSupportEvent(
  tx: StoreTx,
  conversation: { id: string; inboxId: string; workspaceId: string; externalUserId: string | null; verified: boolean },
  type: SupportEventType,
  data: Record<string, string>,
) {
  if (!conversation.verified || !conversation.externalUserId) return;
  const [inbox] = await tx
    .select({ webhookUrl: supportInboxes.webhookUrl })
    .from(supportInboxes)
    .where(eq(supportInboxes.id, conversation.inboxId));
  if (!inbox?.webhookUrl) return;
  await tx.insert(supportWebhookEvents).values({
    workspaceId: conversation.workspaceId,
    inboxId: conversation.inboxId,
    type,
    payload: { conversationId: conversation.id, userId: conversation.externalUserId, ...data },
  });
  void queueDelivery(conversation.inboxId, 2_000);
}

async function claimNext(inboxId: string, now: Date) {
  const [event] = await getDb()
    .update(supportWebhookEvents)
    .set({ nextAttemptAt: new Date(now.getTime() + CLAIM_MS) })
    .where(
      eq(
        supportWebhookEvents.id,
        sql`(select id from ${supportWebhookEvents} where ${and(
          eq(supportWebhookEvents.inboxId, inboxId),
          isNull(supportWebhookEvents.deliveredAt),
          lte(supportWebhookEvents.nextAttemptAt, now),
          gt(supportWebhookEvents.createdAt, new Date(now.getTime() - MAX_AGE_MS)),
        )} order by ${supportWebhookEvents.createdAt} limit 1 for update skip locked)`,
      ),
    )
    .returning();
  return event;
}

export const webhookBody = (event: typeof supportWebhookEvents.$inferSelect) =>
  JSON.stringify({ id: event.id, type: event.type, createdAt: event.createdAt.toISOString(), data: event.payload });

/** Sends what's due for one inbox. Stops at the first failure, and pauses the inbox. */
export async function deliverSupportWebhooks(inboxId: string, post: typeof postToPublicUrl = postToPublicUrl) {
  const db = getDb();
  const now = new Date();
  const [inbox] = await db.select().from(supportInboxes).where(eq(supportInboxes.id, inboxId));
  if (!inbox?.webhookUrl || !inbox.webhookSecretEnc) return { delivered: 0 };
  if (inbox.webhookPausedUntil && inbox.webhookPausedUntil > now) {
    await queueDelivery(inboxId, inbox.webhookPausedUntil.getTime() - now.getTime());
    return { delivered: 0 };
  }
  const secret = decrypt(inbox.webhookSecretEnc);
  let delivered = 0;
  for (let index = 0; index < BATCH; index += 1) {
    const event = await claimNext(inboxId, now);
    if (!event) break;
    const body = webhookBody(event);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    let error: string | null = null;
    try {
      const response = await post(inbox.webhookUrl, body, {
        "Content-Type": "application/json",
        "User-Agent": "HelloBox-Webhooks/1.0",
        "X-HelloBox-Event-Id": event.id,
        "X-HelloBox-Timestamp": timestamp,
        "X-HelloBox-Signature": signWebhook(secret, timestamp, body),
      });
      // Redirects aren't followed, so they fail too.
      if (response.status < 200 || response.status >= 300) error = `HTTP ${response.status}`;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    const attempts = event.attempts + 1;
    if (!error) {
      delivered += 1;
      await db.update(supportWebhookEvents).set({ attempts, deliveredAt: new Date() }).where(eq(supportWebhookEvents.id, event.id));
      continue;
    }
    const failures = inbox.webhookFailures + 1;
    const pausedUntil = new Date(Date.now() + backoff(failures));
    await db.update(supportWebhookEvents)
      .set({ attempts, nextAttemptAt: new Date(Date.now() + backoff(attempts)) })
      .where(eq(supportWebhookEvents.id, event.id));
    await db.update(supportInboxes)
      .set({ webhookFailures: failures, webhookPausedUntil: pausedUntil, webhookError: error.slice(0, 300) })
      .where(eq(supportInboxes.id, inboxId));
    await queueDelivery(inboxId, pausedUntil.getTime() - Date.now());
    return { delivered, error };
  }
  if (delivered && (inbox.webhookFailures || inbox.webhookError)) {
    await db.update(supportInboxes).set({ webhookFailures: 0, webhookPausedUntil: null, webhookError: null }).where(eq(supportInboxes.id, inboxId));
  }
  // More than a batch, or a retry that comes due later.
  const [next] = await db
    .select({ at: min(supportWebhookEvents.nextAttemptAt) })
    .from(supportWebhookEvents)
    .where(and(eq(supportWebhookEvents.inboxId, inboxId), isNull(supportWebhookEvents.deliveredAt), gt(supportWebhookEvents.createdAt, new Date(Date.now() - MAX_AGE_MS))));
  if (next?.at) await queueDelivery(inboxId, Math.max(0, next.at.getTime() - Date.now()));
  return { delivered };
}

/** For maintenance: queues inboxes with events that are due, in case a job was lost. */
export async function queueDueSupportWebhooks() {
  const now = new Date();
  const due = await getDb()
    .selectDistinct({ inboxId: supportWebhookEvents.inboxId })
    .from(supportWebhookEvents)
    .where(and(isNull(supportWebhookEvents.deliveredAt), lte(supportWebhookEvents.nextAttemptAt, now), gt(supportWebhookEvents.createdAt, new Date(now.getTime() - MAX_AGE_MS))))
    .orderBy(asc(supportWebhookEvents.inboxId))
    .limit(500);
  await Promise.all(due.map(({ inboxId }) => queueDelivery(inboxId)));
  await getDb().delete(supportWebhookEvents).where(lt(supportWebhookEvents.createdAt, new Date(now.getTime() - KEEP_MS)));
  return due.length;
}
