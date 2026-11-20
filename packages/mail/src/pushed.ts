import { getDb, webhookEvents } from "@hellobox/db";
import { safeInboundId, type InboundHint } from "@hellobox/providers";
import { enqueueIngest } from "@hellobox/queue";
import { inboundKey, putObject } from "@hellobox/storage";

export interface PushedEmail {
  connectionId: string;
  workspaceId: string;
  emailId: string;
  // The provider's id for this delivery, the same across its retries.
  providerEventId: string;
  raw: Uint8Array;
  hint?: InboundHint;
  // A short summary for webhook_events. Never the message itself.
  payload?: Record<string, unknown>;
}

interface Steps {
  store(key: string, raw: Uint8Array): Promise<void>;
  record(email: PushedEmail & { emailId: string }): Promise<void>;
  enqueue(connectionId: string, emailId: string): Promise<unknown>;
}

const defaultSteps: Steps = {
  store: (key, raw) => putObject(key, raw, "message/rfc822"),
  record: async (email) => {
    await getDb()
      .insert(webhookEvents)
      .values({
        connectionId: email.connectionId,
        providerEventId: email.providerEventId,
        type: "email.received",
        emailId: email.emailId,
        payload: { hint: email.hint ?? {}, ...email.payload },
      })
      .onConflictDoNothing();
  },
  enqueue: enqueueIngest,
};

// For providers whose webhook carries the only full copy of an email. The raw message
// goes to our storage first, then the event is saved, then ingest is queued. Any step
// that throws must make the webhook answer with an error, so the provider sends it
// again. Every step is safe to repeat.
export async function receivePushedEmail(email: PushedEmail, steps: Steps = defaultSteps) {
  const emailId = safeInboundId(email.emailId);
  await steps.store(inboundKey(email.workspaceId, email.connectionId, emailId), email.raw);
  await steps.record({ ...email, emailId });
  await steps.enqueue(email.connectionId, emailId);
  return { emailId };
}
