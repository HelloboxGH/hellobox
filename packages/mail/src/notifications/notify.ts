import { randomBytes } from "node:crypto";
import { getEnv } from "@hellobox/config";
import { entitlementsFor } from "@hellobox/extensions";
import {
  domains, getDb, mailboxes, mailboxMembers, members, messages, notificationChannels, notificationSettings, threads,
  threadUserState, user, workspaces,
} from "@hellobox/db";
import { NewMailDigest, sendAppEmail } from "@hellobox/email";
import { enqueueNotifyFlush } from "@hellobox/queue";
import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import Redis from "ioredis";
import { createElement } from "react";
import { notifiesFor, notifyingDomain } from "../domains";
import { readableMailboxIds } from "../mailbox-access";
import {
  type ChannelConfig, ChannelGone, deliver, type NotificationKind, notificationEnv, type Notice, openConfig, sealConfig,
  telegramCall,
} from "./channels";

let redis: Redis | undefined;
const getRedis = () => (redis ??= new Redis(getEnv().REDIS_URL));

// How long a channel waits after a notification before sending the next one. Mail that
// arrives meanwhile is collapsed into one "N new messages". Webhooks get every event.
const QUIET_MS: Record<NotificationKind, number> = {
  email: 120_000,
  discord: 10_000,
  slack: 10_000,
  telegram: 10_000,
  ntfy: 10_000,
  browser: 5_000,
  webhook: 0,
};

// After this many failures in a row a channel turns itself off.
const MAX_FAILURES = 5;

type ChannelRow = typeof notificationChannels.$inferSelect;

export const threadUrl = (workspaceId: string, threadId: string) =>
  `${notificationEnv().appUrl}/inbox?${new URLSearchParams({ workspace: workspaceId, thread: threadId })}`;
export const inboxUrl = (workspaceId: string) => `${notificationEnv().appUrl}/inbox?workspace=${encodeURIComponent(workspaceId)}`;
const excerptOf = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 280);

async function loadMessage(messageId: string) {
  const [row] = await getDb()
    .select({
      message: messages,
      thread: threads,
      mailbox: { id: mailboxes.id, address: mailboxes.address, personalUserId: mailboxes.personalUserId },
      domain: { enabled: domains.enabled, removedAt: domains.removedAt },
      workspace: { id: workspaces.id, name: workspaces.name, demoExpiresAt: workspaces.demoExpiresAt },
    })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .innerJoin(domains, eq(domains.id, mailboxes.domainId))
    .innerJoin(workspaces, eq(workspaces.id, messages.workspaceId))
    .where(eq(messages.id, messageId));
  return row;
}

function noticeFor(row: NonNullable<Awaited<ReturnType<typeof loadMessage>>>): Notice {
  return {
    workspace: row.workspace.name,
    mailbox: row.mailbox.address,
    fromName: row.message.fromName,
    fromAddress: row.message.fromAddress,
    subject: row.message.subject,
    excerpt: excerptOf(row.message.textBody || row.message.snippet),
    url: threadUrl(row.workspace.id, row.thread.id),
    receivedAt: row.message.sentAt.toISOString(),
    threadId: row.thread.id,
    messageId: row.message.id,
    count: 1,
  };
}

// The people who can read a mailbox: assigned members of a shared one, or its owner.
export async function readersOf(workspaceId: string, mailbox: { id: string; personalUserId: string | null }) {
  if (mailbox.personalUserId) return [mailbox.personalUserId];
  const rows = await getDb()
    .select({ userId: mailboxMembers.userId })
    .from(mailboxMembers)
    .innerJoin(members, and(eq(members.userId, mailboxMembers.userId), eq(members.workspaceId, workspaceId)))
    .where(eq(mailboxMembers.mailboxId, mailbox.id));
  return rows.map((row) => row.userId);
}

/** Runs after ingest stores a message: tells everyone who reads that mailbox, on their channels. */
export async function notifyNewMessage(messageId: string) {
  const row = await loadMessage(messageId);
  if (!row || row.message.direction !== "inbound") return { sent: 0 };
  // Spam and anything already moved out of the inbox stay quiet.
  if (row.thread.folder !== "inbox") return { sent: 0 };
  // Domains that are switched off or removed stay quiet.
  if (!notifiesFor(row.domain)) return { sent: 0 };
  // Demo sandboxes never notify anyone.
  if (row.workspace.demoExpiresAt) return { sent: 0 };
  const readers = await readersOf(row.workspace.id, row.mailbox);
  if (!readers.length) return { sent: 0 };

  const db = getDb();
  const [channels, settings, snoozed] = await Promise.all([
    db
      .select()
      .from(notificationChannels)
      .where(
        and(
          eq(notificationChannels.workspaceId, row.workspace.id),
          inArray(notificationChannels.userId, readers),
          eq(notificationChannels.enabled, true),
        ),
      ),
    db
      .select()
      .from(notificationSettings)
      .where(and(eq(notificationSettings.workspaceId, row.workspace.id), inArray(notificationSettings.userId, readers))),
    db
      .select({ userId: threadUserState.userId })
      .from(threadUserState)
      .where(and(eq(threadUserState.threadId, row.thread.id), gt(threadUserState.snoozedUntil, new Date()))),
  ]);
  const quiet = new Set(snoozed.map((s) => s.userId));
  const wants = (userId: string) => {
    if (quiet.has(userId)) return false;
    const setting = settings.find((s) => s.userId === userId);
    if (setting?.mailboxIds && !setting.mailboxIds.includes(row.mailbox.id)) return false;
    if (setting?.primaryOnly && row.thread.category !== "primary") return false;
    return true;
  };
  // Instant email is for paid plans. The free plan gets the hourly digest instead.
  const instantEmail = (await entitlementsFor(row.workspace.id)).features.instantEmail;
  const targets = channels.filter((c) => wants(c.userId) && !(c.kind === "email" && !instantEmail));
  if (!targets.length) return { sent: 0 };

  const emails = await emailsOf(targets.map((c) => c.userId));
  const notice = noticeFor(row);
  let sent = 0;
  for (const channel of targets) {
    const quietMs = QUIET_MS[channel.kind];
    if (quietMs > 0) {
      const r = getRedis();
      const free = await r.set(`notify:recent:${channel.id}`, "1", "PX", quietMs, "NX");
      if (!free) {
        // Sent one moments ago: hold this one for the flush, which sends them together.
        await r.rpush(`notify:pending:${channel.id}`, messageId);
        await r.pexpire(`notify:pending:${channel.id}`, 24 * 3_600_000);
        await enqueueNotifyFlush(channel.id, quietMs);
        continue;
      }
    }
    if (await send(channel, notice, emails.get(channel.userId) ?? "")) sent++;
  }
  return { sent };
}

/** Sends what piled up on a channel while it was quiet, as one message. */
export async function flushChannel(channelId: string) {
  const r = getRedis();
  const key = `notify:pending:${channelId}`;
  const [[, ids]] = (await r.multi().lrange(key, 0, -1).del(key).exec()) as [[null, string[]], unknown];
  if (!ids?.length) return { sent: 0 };
  const [channel] = await getDb().select().from(notificationChannels).where(eq(notificationChannels.id, channelId));
  if (!channel?.enabled) return { sent: 0 };

  const rows = (await Promise.all([...new Set(ids)].map(loadMessage))).filter(
    (row): row is NonNullable<typeof row> => !!row && row.thread.folder === "inbox" && notifiesFor(row.domain),
  );
  if (!rows.length) return { sent: 0 };
  rows.sort((a, b) => b.message.sentAt.getTime() - a.message.sentAt.getTime());
  const latest = noticeFor(rows[0]!);
  const notice: Notice =
    rows.length === 1
      ? latest
      : {
          ...latest,
          count: rows.length,
          url: inboxUrl(rows[0]!.workspace.id),
          threadId: null,
          messageId: null,
          lines: rows.map((row) => ({
            from: row.message.fromName || row.message.fromAddress,
            subject: row.message.subject,
            mailbox: row.mailbox.address,
          })),
        };
  await r.set(`notify:recent:${channelId}`, "1", "PX", QUIET_MS[channel.kind] || 1);
  const emails = await emailsOf([channel.userId]);
  return { sent: (await send(channel, notice, emails.get(channel.userId) ?? "")) ? 1 : 0 };
}

async function emailsOf(userIds: string[]) {
  const rows = await getDb().select({ id: user.id, email: user.email }).from(user).where(inArray(user.id, [...new Set(userIds)]));
  return new Map(rows.map((row) => [row.id, row.email]));
}

// Delivers and records the outcome. Never throws, so one broken channel can't stop the rest.
async function send(channel: ChannelRow, notice: Notice, email: string) {
  const db = getDb();
  try {
    await deliver(openConfig(channel.configEnc), notice, { preview: channel.preview, email });
    await db
      .update(notificationChannels)
      .set({ failures: 0, lastSentAt: new Date() })
      .where(eq(notificationChannels.id, channel.id));
    return true;
  } catch (error) {
    const gone = error instanceof ChannelGone;
    const failures = channel.failures + 1;
    const off = gone || failures >= MAX_FAILURES;
    const reason = gone
      ? error.message
      : `Stopped after ${MAX_FAILURES} failed attempts. Last error: ${error instanceof Error ? error.message : String(error)}`;
    await db
      .update(notificationChannels)
      .set({ failures, ...(off ? { enabled: false, disabledReason: reason.slice(0, 500) } : {}) })
      .where(eq(notificationChannels.id, channel.id));
    console.error(`[notify] ${channel.kind} ${channel.id} failed${off ? " and was turned off" : ""}:`, error);
    return false;
  }
}

/** "Send a test" in Settings. Reports failure without counting it against the channel. */
// Test sends are capped so nobody uses them to spam: email costs us money and reputation, so it
// gets two in all (per person and workspace, so re-adding the channel doesn't reset it); every
// other channel gets two per 30 minutes. Returns null when allowed, or why not.
export const TEST_LIMIT = 2;
export async function claimTestSend(channel: { id: string; kind: string; workspaceId: string; userId: string }) {
  const email = channel.kind === "email";
  const key = email ? `notify:test:email:${channel.workspaceId}:${channel.userId}` : `notify:test:${channel.id}`;
  const r = getRedis();
  const used = await r.incr(key);
  if (used === 1 && !email) await r.pexpire(key, 30 * 60_000);
  if (used <= TEST_LIMIT) return null;
  if (email) return `Email tests are limited to ${TEST_LIMIT}. Your email notifications are on and will arrive with new mail.`;
  const left = await r.pttl(key);
  const minutes = Math.max(1, Math.ceil(left / 60_000));
  return `You can send ${TEST_LIMIT} tests every 30 minutes. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

export async function sendTestNotification(channelId: string) {
  const [row] = await getDb()
    .select({ channel: notificationChannels, workspace: workspaces.name, email: user.email })
    .from(notificationChannels)
    .innerJoin(workspaces, eq(workspaces.id, notificationChannels.workspaceId))
    .innerJoin(user, eq(user.id, notificationChannels.userId))
    .where(eq(notificationChannels.id, channelId));
  if (!row) return { ok: false };
  const notice: Notice = {
    workspace: row.workspace,
    mailbox: "hello@example.com",
    fromName: "HelloBox",
    fromAddress: "hello@hellobox.app",
    subject: "This is a test notification",
    excerpt: "If you can read this, notifications from HelloBox reach you here.",
    url: `${notificationEnv().appUrl}/settings?tab=notifications`,
    receivedAt: new Date().toISOString(),
    threadId: null,
    messageId: null,
    count: 1,
    test: true,
  };
  try {
    await deliver(openConfig(row.channel.configEnc), notice, { preview: row.channel.preview, email: row.email });
    await getDb()
      .update(notificationChannels)
      .set({ failures: 0, lastSentAt: new Date(), enabled: true, disabledReason: null })
      .where(eq(notificationChannels.id, channelId));
    return { ok: true };
  } catch (error) {
    await getDb()
      .update(notificationChannels)
      .set({ disabledReason: `Test failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500) })
      .where(eq(notificationChannels.id, channelId));
    return { ok: false };
  }
}

/**
 * The free plan's email: once an hour at most, a generic "you have new messages" when
 * unread mail arrived in the inbox since the last one. Paid plans get instant email instead.
 */
export async function sendNotificationDigests(now = new Date()) {
  const db = getDb();
  const channels = await db
    .select({
      userId: notificationChannels.userId,
      workspaceId: notificationChannels.workspaceId,
      createdAt: notificationChannels.createdAt,
      workspace: workspaces.name,
      email: user.email,
    })
    .from(notificationChannels)
    .innerJoin(workspaces, eq(workspaces.id, notificationChannels.workspaceId))
    .innerJoin(user, eq(user.id, notificationChannels.userId))
    .where(and(eq(notificationChannels.kind, "email"), eq(notificationChannels.enabled, true)));

  let sent = 0;
  const instant = new Map<string, boolean>();
  for (const channel of channels) {
    if (!instant.has(channel.workspaceId)) {
      instant.set(channel.workspaceId, (await entitlementsFor(channel.workspaceId)).features.instantEmail);
    }
    // Workspaces with instant email never get the digest.
    if (instant.get(channel.workspaceId)) continue;
    const [setting] = await db
      .select()
      .from(notificationSettings)
      .where(and(eq(notificationSettings.workspaceId, channel.workspaceId), eq(notificationSettings.userId, channel.userId)));
    const since = setting?.digestSentAt ?? channel.createdAt;
    let mailboxIds = await readableMailboxIds(channel.workspaceId, channel.userId);
    if (setting?.mailboxIds) mailboxIds = mailboxIds.filter((id) => setting.mailboxIds!.includes(id));
    if (!mailboxIds.length) continue;

    const [fresh] = await db
      .select({ id: messages.id })
      .from(messages)
      .innerJoin(threads, eq(threads.id, messages.threadId))
      .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
      .innerJoin(domains, eq(domains.id, mailboxes.domainId))
      .leftJoin(threadUserState, and(eq(threadUserState.threadId, threads.id), eq(threadUserState.userId, channel.userId)))
      .where(
        and(
          inArray(threads.mailboxId, mailboxIds),
          eq(messages.direction, "inbound"),
          gt(messages.createdAt, since),
          eq(threads.folder, "inbox"),
          notifyingDomain(),
          setting?.primaryOnly ? eq(threads.category, "primary") : undefined,
          // Mail they already read doesn't need a reminder.
          isNull(threadUserState.readAt),
          or(isNull(threadUserState.snoozedUntil), sql`${threadUserState.snoozedUntil} <= now()`),
        ),
      )
      .limit(1);
    if (fresh) {
      try {
        await sendAppEmail({
          to: channel.email,
          subject: `You have new messages in ${channel.workspace}`,
          react: createElement(NewMailDigest, { workspace: channel.workspace, url: inboxUrl(channel.workspaceId) }),
        });
        sent++;
      } catch (error) {
        console.error("[notify] digest failed:", error);
        continue;
      }
    }
    await db
      .insert(notificationSettings)
      .values({ workspaceId: channel.workspaceId, userId: channel.userId, digestSentAt: now })
      .onConflictDoUpdate({ target: [notificationSettings.workspaceId, notificationSettings.userId], set: { digestSentAt: now } });
  }
  return { sent };
}

// Telegram: "Connect Telegram" opens t.me/<bot>?start=<code>, and the bot's webhook
// links the chat that pressed Start to the person who asked.

const TELEGRAM_CODE_TTL = 15 * 60;

export async function createTelegramLink(workspaceId: string, userId: string) {
  const telegram = notificationEnv().telegram;
  if (!telegram?.username) throw new Error("Telegram isn't set up on this server");
  const code = randomBytes(18).toString("base64url");
  await getRedis().set(`notify:tg-link:${code}`, JSON.stringify({ workspaceId, userId }), "EX", TELEGRAM_CODE_TTL);
  return { url: `https://t.me/${telegram.username}?start=${code}`, groupUrl: `https://t.me/${telegram.username}?startgroup=${code}` };
}

type TelegramUpdate = {
  message?: { text?: string; chat: { id: number; type: string; title?: string; first_name?: string; username?: string } };
};

export async function handleTelegramUpdate(update: TelegramUpdate) {
  const message = update.message;
  const match = message?.text?.match(/^\/start(?:@\w+)?\s+([\w-]{10,64})$/);
  if (!message) return;
  const chat = message.chat;
  if (!match) {
    if (message.text?.startsWith("/start")) {
      await telegramCall("sendMessage", { chat_id: chat.id, text: "Open HelloBox → Settings → Notifications and press Connect Telegram to link this chat." });
    }
    return;
  }
  const key = `notify:tg-link:${match[1]}`;
  const raw = await getRedis().getdel(key);
  if (!raw) {
    await telegramCall("sendMessage", { chat_id: chat.id, text: "That link expired. Press Connect Telegram in HelloBox again." });
    return;
  }
  const { workspaceId, userId } = JSON.parse(raw) as { workspaceId: string; userId: string };
  const [workspace] = await getDb().select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!workspace) return;
  const where = chat.type === "private" ? (chat.username ? `@${chat.username}` : chat.first_name || "you") : chat.title || "group";
  await addChannel({ workspaceId, userId, label: `Telegram · ${where}`, config: { kind: "telegram", chatId: chat.id }, preview: true });
  await telegramCall("sendMessage", {
    chat_id: chat.id,
    text: `Connected to ${workspace.name}. New mail will show up here.`,
  });
}

export async function setTelegramWebhook() {
  const telegram = notificationEnv().telegram;
  const appUrl = notificationEnv().appUrl;
  // Telegram only calls https addresses, so local development skips this.
  if (!telegram?.secret || !appUrl.startsWith("https://")) return { set: false };
  const res = await telegramCall("setWebhook", {
    url: `${appUrl}/api/webhooks/telegram`,
    secret_token: telegram.secret,
    allowed_updates: ["message"],
  });
  if (!res.ok) throw new Error(`Telegram setWebhook failed: ${res.description ?? res.status}`);
  return { set: true };
}

export async function addChannel(input: {
  workspaceId: string;
  userId: string;
  label: string;
  config: ChannelConfig;
  preview: boolean;
}) {
  const [row] = await getDb()
    .insert(notificationChannels)
    .values({
      workspaceId: input.workspaceId,
      userId: input.userId,
      kind: input.config.kind,
      label: input.label.slice(0, 120),
      configEnc: sealConfig(input.config),
      preview: input.preview,
    })
    .returning({ id: notificationChannels.id });
  return row!.id;
}

/** Someone left the workspace or lost access: their channels there stop. */
export async function removeNotificationChannels(workspaceId: string, userId: string) {
  const db = getDb();
  await db
    .delete(notificationChannels)
    .where(and(eq(notificationChannels.workspaceId, workspaceId), eq(notificationChannels.userId, userId)));
  await db
    .delete(notificationSettings)
    .where(and(eq(notificationSettings.workspaceId, workspaceId), eq(notificationSettings.userId, userId)));
}

export const latestChannels = (workspaceId: string, userId: string) =>
  getDb()
    .select()
    .from(notificationChannels)
    .where(and(eq(notificationChannels.workspaceId, workspaceId), eq(notificationChannels.userId, userId)))
    .orderBy(desc(notificationChannels.createdAt));
