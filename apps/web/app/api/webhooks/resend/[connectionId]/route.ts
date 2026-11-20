import { decrypt } from "@hellobox/config";
import { getDb, connections, webhookEvents } from "@hellobox/db";
import { recordContactOptOut, recordDeliveryEvent, resendDeliveryDetail } from "@hellobox/mail";
import { enqueueIngest } from "@hellobox/queue";
import { verifyWebhook, type WebhookEvent } from "@hellobox/resend";
import { eq } from "drizzle-orm";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ connectionId: string }> },
) {
  const { connectionId } = await params;
  const db = getDb();
  const [connection] = await db
    .select({
      id: connections.id,
      secret: connections.webhookSecretEnc,
    })
    .from(connections)
    .where(eq(connections.id, connectionId));
  if (!connection?.secret) return new Response("Not found", { status: 404 });

  // Signatures cover the exact bytes, so this must be the raw body.
  const body = await request.text();
  let event: WebhookEvent;
  try {
    event = verifyWebhook(body, request.headers, decrypt(connection.secret));
  } catch {
    return new Response("Invalid signature", { status: 401 });
  }

  const providerEventId = request.headers.get("svix-id") ?? crypto.randomUUID();
  const emailId = event.data.email_id ?? null;
  // Saved before anything else, so a queue outage can't lose the event. A
  // non-2xx response makes Resend retry, and the backfill job is the final net.
  await db
    .insert(webhookEvents)
    .values({
      connectionId,
      providerEventId,
      type: event.type,
      emailId,
      payload: event,
    })
    .onConflictDoNothing();

  // Opt-outs made through Resend's unsubscribe link. They're also pulled before every
  // campaign, for connections whose webhook predates contact events.
  if (event.type === "contact.updated" && event.data.unsubscribed === true && typeof event.data.email === "string") {
    await recordContactOptOut(connectionId, event.data.email);
  }

  if (emailId) {
    if (event.type === "email.received") {
      await enqueueIngest(connectionId, emailId);
    } else {
      // Resend names a bounce's type: only a permanent one counts as bounced.
      const { type, recipients, reason } = resendDeliveryDetail(event);
      await recordDeliveryEvent(connectionId, type, emailId, { recipients, reason });
    }
  }
  return new Response(null, { status: 204 });
}
