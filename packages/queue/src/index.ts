import { getEnv } from "@hellobox/config";
import { Queue } from "bullmq";
import { Redis } from "ioredis";

export const MAIL_QUEUE = "mail";

export type MailJob =
  | { name: "ingest"; data: { connectionId: string; emailId: string } }
  | { name: "send"; data: { outboxId: string } }
  | { name: "backfill"; data: { connectionId: string } }
  | { name: "purge-workspace"; data: { workspaceId: string } }
  | { name: "maintenance"; data: Record<string, never> }
  | { name: "sync-contacts"; data: { workspaceId: string } }
  | { name: "unsync-contacts"; data: { workspaceId: string; emails: string[] } }
  | { name: "send-campaign"; data: { campaignId: string } }
  | { name: "provision-ses"; data: { connectionId: string } }
  | { name: "postmark-inbound"; data: { connectionId: string } }
  | { name: "notify"; data: { messageId: string } }
  | { name: "notify-flush"; data: { channelId: string } }
  | { name: "notify-test"; data: { channelId: string } }
  | { name: "notify-digest"; data: Record<string, never> }
  | { name: "team-email"; data: { workspaceId: string; userId: string } };

export function getRedisConnection() {
  const url = new URL(getEnv().REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: decodeURIComponent(url.password) || undefined,
    maxRetriesPerRequest: null,
  };
}

let queue: Queue | undefined;

export function getMailQueue() {
  queue ??= new Queue(MAIL_QUEUE, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      attempts: 8,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: 1_000,
      removeOnFail: false,
    },
  });
  return queue;
}

export const enqueueWorkspacePurge = (workspaceId: string) =>
  getMailQueue().add("purge-workspace", { workspaceId });

export const enqueueIngest = (connectionId: string, emailId: string, delayMs = 0) =>
  getMailQueue().add(
    "ingest",
    { connectionId, emailId },
    // BullMQ ignores a job whose id already exists, which absorbs repeat webhooks.
    { jobId: `ingest_${connectionId}_${emailId}`, delay: Math.max(0, delayMs) },
  );

export const sendJobId = (outboxId: string) => `send_${outboxId}`;

export const enqueueSend = (outboxId: string, delayMs = 0) =>
  getMailQueue().add(
    "send",
    { outboxId },
    { jobId: sendJobId(outboxId), delay: Math.max(0, delayMs) },
  );

export const realtimeChannel = (workspaceId: string) =>
  `workspace:${workspaceId}:events`;

let publisher: Redis | undefined;

export async function publishWorkspaceEvent(
  workspaceId: string,
  event: { type: string; threadId?: string },
) {
  publisher ??= new Redis(getRedisConnection());
  await publisher.publish(realtimeChannel(workspaceId), JSON.stringify(event));
}

export function createSubscriber() {
  return new Redis(getRedisConnection());
}

export const enqueueBackfill = (connectionId: string) =>
  getMailQueue().add("backfill", { connectionId });

// One sync per workspace at a time. Changes made while one runs stay pending, and the
// next sync or the maintenance job picks them up.
export const enqueueContactSync = (workspaceId: string) =>
  getMailQueue().add(
    "sync-contacts",
    { workspaceId },
    { jobId: `sync-contacts_${workspaceId}`, delay: 2_000, removeOnComplete: true, removeOnFail: true },
  );

export const enqueueContactUnsync = (workspaceId: string, emails: string[]) =>
  getMailQueue().add("unsync-contacts", { workspaceId, emails });

export const enqueueCampaign = (campaignId: string) =>
  getMailQueue().add("send-campaign", { campaignId }, { jobId: `campaign_${campaignId}` });

// A new role can take a few seconds to work everywhere in IAM, so this retries quickly.
export const enqueueSesProvision = (connectionId: string) =>
  getMailQueue().add(
    "provision-ses",
    { connectionId },
    { jobId: `provision-ses_${connectionId}_${Date.now()}`, attempts: 10, backoff: { type: "exponential", delay: 3_000 } },
  );

// Postmark takes an inbound domain only once it sees the MX record, and mail to the domain
// bounces until then, so this checks every minute for an hour. Maintenance keeps trying after.
export const enqueuePostmarkInbound = (connectionId: string) =>
  getMailQueue().add(
    "postmark-inbound",
    { connectionId },
    { jobId: `postmark-inbound_${connectionId}_${Date.now()}`, delay: 30_000, attempts: 60, backoff: { type: "fixed", delay: 60_000 } },
  );

// Notifications don't retry: a late "new mail" is worse than none, and retrying would
// repeat the channels that already got it.
const once = { attempts: 1, removeOnComplete: true, removeOnFail: 500 };

export const enqueueNotify = (messageId: string) =>
  getMailQueue().add("notify", { messageId }, { ...once, jobId: `notify_${messageId}` });

// One flush per channel at a time; mail that arrives meanwhile joins it.
export const enqueueNotifyFlush = (channelId: string, delayMs: number) =>
  getMailQueue().add("notify-flush", { channelId }, { ...once, jobId: `notify-flush_${channelId}`, delay: delayMs });

export const enqueueNotifyTest = (channelId: string) =>
  getMailQueue().add("notify-test", { channelId }, once);

// Emails about something a teammate did, like assigning a conversation. It waits a little,
// so a quick change of mind or a notification already seen in the app sends nothing, and
// everything from that moment goes out as one email. One job per person per 30 seconds; the
// job claims what it sends, so two never send the same notification.
export const TEAM_EMAIL_DELAY_MS = 30_000;
export const enqueueTeamEmail = (workspaceId: string, userId: string) =>
  getMailQueue().add(
    "team-email",
    { workspaceId, userId },
    {
      ...once,
      jobId: `team-email_${workspaceId}_${userId}_${Math.floor(Date.now() / TEAM_EMAIL_DELAY_MS)}`,
      delay: TEAM_EMAIL_DELAY_MS,
    },
  );
