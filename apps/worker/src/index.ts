import { getExtensions } from "./extensions";
import {
  backfillConnection,
  digestTimeZone,
  grantErrorProvider,
  markIfRoleRevoked,
  reconnectMessage,
  sendSignupDigest,
  ingestEmail,
  failImport,
  runImport,
  provisionSesConnection,
  activatePendingPostmarkInbound,
  sendCampaign,
  sendOutbox,
  notifyNewMessage,
  deliverSupportWebhooks,
  flushChannel,
  sendNotificationDigests,
  sendTestNotification,
  sendTeamEmail,
  setTelegramWebhook,
  syncContacts,
  unsyncContacts,
} from "@hellobox/mail";
import {
  enqueueBackfill,
  enqueueContactSync,
  enqueueIngest,
  enqueueNotify,
  getMailQueue,
  getRedisConnection,
  MAIL_QUEUE,
} from "@hellobox/queue";
import { campaigns, outbox, getDb } from "@hellobox/db";
import { eq } from "drizzle-orm";
import { type Job, UnrecoverableError, Worker } from "bullmq";
import { purgeWorkspaceFiles, runMaintenance } from "./maintenance";

async function runJob(job: Job) {
    switch (job.name) {
      case "ingest": {
        const result = await ingestEmail(job.data.connectionId, job.data.emailId);
        if (result.status === "ingested") await enqueueNotify(result.messageId);
        return result;
      }
      case "notify":
        return notifyNewMessage(job.data.messageId);
      case "support-webhook":
        return deliverSupportWebhooks(job.data.inboxId);
      case "notify-flush":
        return flushChannel(job.data.channelId);
      case "notify-test":
        return sendTestNotification(job.data.channelId);
      case "notify-digest":
        return sendNotificationDigests();
      case "team-email":
        return sendTeamEmail(job.data.workspaceId, job.data.userId);
      case "send":
        return sendOutbox(job.data.outboxId);
      case "backfill":
        return backfillConnection(job.data.connectionId, (emailId) =>
          enqueueIngest(job.data.connectionId, emailId),
        );
      case "purge-workspace":
        return purgeWorkspaceFiles(job.data.workspaceId);
      case "maintenance":
        return runMaintenance(enqueueBackfill, enqueueContactSync);
      case "sync-contacts":
        return syncContacts(job.data.workspaceId);
      case "unsync-contacts":
        return unsyncContacts(job.data.workspaceId, job.data.emails);
      case "send-campaign":
        return sendCampaign(job.data.campaignId);
      case "signup-digest":
        return sendSignupDigest();
      case "provision-ses":
        return provisionSesConnection(job.data.connectionId);
      case "postmark-inbound":
        // Throwing retries it in a minute.
        if (!(await activatePendingPostmarkInbound(job.data.connectionId))) {
          throw new Error("Postmark can't see the MX record yet");
        }
        return;
      case "import":
        return runImport(job.data.importId);
      default: {
        const handler = getExtensions().jobs.handlers?.[job.name];
        if (!handler) throw new Error(`Unknown job: ${job.name}`);
        return handler(job.data);
      }
    }
}

const worker = new Worker(
  MAIL_QUEUE,
  async (job) => {
    try {
      return await runJob(job);
    } catch (error) {
      // Access the customer has to give again never comes back by retrying. The
      // connection is marked so the app asks them to reconnect, maintenance stops queueing
      // its jobs, and this one fails now instead of retrying with backoff.
      const provider = grantErrorProvider(error);
      if (!provider) throw error;
      const connectionId = (job.data as { connectionId?: unknown }).connectionId;
      if (typeof connectionId === "string") await markIfRoleRevoked(connectionId, error);
      throw new UnrecoverableError(reconnectMessage(provider));
    }
  },
  { connection: getRedisConnection(), concurrency: 5 },
);

worker.on("failed", async (job, err) => {
  console.error(`[worker] ${job?.name} ${job?.id} failed: ${err.message}`);
  // Out of retries: show the user that the email didn't go out.
  const final = err.name === "UnrecoverableError" || (job?.attemptsMade ?? 0) >= (job?.opts.attempts ?? 1);
  if (job?.name === "send" && final) {
    await getDb()
      .update(outbox)
      .set({ status: "failed", error: err.message })
      .where(eq(outbox.id, job.data.outboxId));
  }
  if (job?.name === "import" && final) {
    await failImport(job.data.importId, "The import stopped unexpectedly. Try again; emails already imported are skipped.");
  }
  if (job?.name === "send-campaign" && final) {
    await getDb()
      .update(campaigns)
      .set({ status: "failed", error: err.message })
      .where(eq(campaigns.id, job.data.campaignId));
  }
});

await getMailQueue().upsertJobScheduler(
  "maintenance",
  { every: 15 * 60 * 1000 },
  { name: "maintenance", data: {} },
);

// The free plan's email notifications: one generic digest an hour at most.
await getMailQueue().upsertJobScheduler(
  "notify-digest",
  { pattern: "0 * * * *" },
  { name: "notify-digest", data: {} },
);

// Points the Telegram bot at our webhook. Safe to repeat on every start.
await setTelegramWebhook().catch((error: unknown) => console.error("[worker] Telegram webhook:", error));

// Platform admins hear about the day's signups just before midnight.
await getMailQueue().upsertJobScheduler(
  "signup-digest",
  { pattern: "59 23 * * *", tz: digestTimeZone() },
  { name: "signup-digest", data: {} },
);

// Jobs the cloud entry adds (analytics upkeep, ...).
for (const { id, enabled = true, ...schedule } of getExtensions().jobs.schedules ?? []) {
  if (enabled) await getMailQueue().upsertJobScheduler(id, schedule, { name: id, data: {} });
  else await getMailQueue().removeJobScheduler(id);
}

async function shutdown() {
  await worker.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

console.log("[worker] started");
