import { createHmac } from "node:crypto";
import { decrypt, encrypt, getEnv, setting } from "@hellobox/config";
import { NewMail, sendAppEmail } from "@hellobox/email";
import { createElement } from "react";
import webpush from "web-push";
import { assertPublicUrl, postToPublicUrl, UnsafeUrlError } from "../safe-url";

export type NotificationKind = "email" | "discord" | "slack" | "telegram" | "ntfy" | "webhook" | "browser";

export type PushSubscription = { endpoint: string; keys: { p256dh: string; auth: string } };

// Stored encrypted. Email has nothing: it always goes to the person's own account address.
export type ChannelConfig =
  | { kind: "email" }
  | { kind: "discord"; url: string }
  | { kind: "slack"; url: string }
  | { kind: "telegram"; chatId: number }
  | { kind: "ntfy"; server: string; topic: string; token?: string }
  | { kind: "webhook"; url: string; secret: string }
  | { kind: "browser"; subscription: PushSubscription };

export const sealConfig = (config: ChannelConfig) => encrypt(JSON.stringify(config));
export const openConfig = (sealed: string) => JSON.parse(decrypt(sealed)) as ChannelConfig;

/** What one notification says. `count` above 1 means a burst collapsed into one message. */
export type Notice = {
  workspace: string;
  mailbox: string;
  fromName: string | null;
  fromAddress: string;
  subject: string;
  excerpt: string;
  url: string;
  receivedAt: string;
  threadId: string | null;
  messageId: string | null;
  count: number;
  // For a collapsed burst: one line per message, newest first.
  lines?: { from: string; subject: string; mailbox: string }[];
  test?: boolean;
};

// The channel's destination is gone for good (deleted webhook, blocked bot, expired
// subscription). The caller turns the channel off with this reason.
export class ChannelGone extends Error {}

export function notificationEnv() {
  const env = {
    TELEGRAM_BOT_TOKEN: setting("TELEGRAM_BOT_TOKEN"),
    TELEGRAM_BOT_USERNAME: setting("TELEGRAM_BOT_USERNAME"),
    TELEGRAM_WEBHOOK_SECRET: setting("TELEGRAM_WEBHOOK_SECRET"),
    VAPID_PUBLIC_KEY: setting("VAPID_PUBLIC_KEY"),
    VAPID_PRIVATE_KEY: setting("VAPID_PRIVATE_KEY"),
    VAPID_SUBJECT: setting("VAPID_SUBJECT"),
    SUPPORT_EMAIL: setting("SUPPORT_EMAIL"),
    NTFY_URL: setting("NTFY_URL"),
    NTFY_TOKEN: setting("NTFY_TOKEN"),
    DISCORD_CLIENT_ID: setting("DISCORD_CLIENT_ID"),
    DISCORD_CLIENT_SECRET: setting("DISCORD_CLIENT_SECRET"),
    SLACK_CLIENT_ID: setting("SLACK_CLIENT_ID"),
    SLACK_CLIENT_SECRET: setting("SLACK_CLIENT_SECRET"),
  };
  return {
    appUrl: getEnv().APP_URL.replace(/\/$/, ""),
    telegram: env.TELEGRAM_BOT_TOKEN
      ? { token: env.TELEGRAM_BOT_TOKEN, username: env.TELEGRAM_BOT_USERNAME ?? "", secret: env.TELEGRAM_WEBHOOK_SECRET ?? "" }
      : null,
    // The web app only needs the public key, to subscribe browsers. Sending needs both.
    vapidPublicKey: env.VAPID_PUBLIC_KEY || null,
    vapid:
      env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY
        ? { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT || (env.SUPPORT_EMAIL ? `mailto:${env.SUPPORT_EMAIL}` : getEnv().APP_URL) }
        : null,
    ntfy: env.NTFY_URL ? { url: env.NTFY_URL.replace(/\/$/, ""), token: env.NTFY_TOKEN || undefined } : null,
    discord: env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET ? { id: env.DISCORD_CLIENT_ID, secret: env.DISCORD_CLIENT_SECRET } : null,
    slack: env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET ? { id: env.SLACK_CLIENT_ID, secret: env.SLACK_CLIENT_SECRET } : null,
  };
}

// Webhook URLs for Discord and Slack only ever point at their own hosts.
export function checkDiscordUrl(raw: string) {
  const url = assertPublicUrl(raw.trim());
  if (!/^(?:canary\.|ptb\.)?discord(?:app)?\.com$/.test(url.hostname) || !/^\/api\/webhooks\/\d+\/[\w-]+\/?$/.test(url.pathname)) {
    throw new UnsafeUrlError("That isn't a Discord webhook URL. It starts with https://discord.com/api/webhooks/");
  }
  return `https://discord.com${url.pathname.replace(/\/$/, "")}`;
}

export function checkSlackUrl(raw: string) {
  const url = assertPublicUrl(raw.trim());
  if (url.hostname !== "hooks.slack.com" || !url.pathname.startsWith("/services/")) {
    throw new UnsafeUrlError("That isn't a Slack webhook URL. It starts with https://hooks.slack.com/services/");
  }
  return url.toString();
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const sender = (notice: Notice) => (notice.fromName ? `${notice.fromName} <${notice.fromAddress}>` : notice.fromAddress);

/** Title and body in plain words, shared by the channels that don't have their own layout. */
export function plainText(notice: Notice, preview: boolean) {
  if (notice.count > 1) {
    const mailboxes = [...new Set((notice.lines ?? []).map((line) => line.mailbox))].join(", ");
    return {
      title: `${notice.count} new messages${preview && mailboxes ? ` in ${mailboxes}` : ""}`,
      body: preview
        ? (notice.lines ?? []).slice(0, 5).map((line) => `${line.from}: ${line.subject || "(no subject)"}`).join("\n")
        : `Open ${notice.workspace} in HelloBox to read them.`,
    };
  }
  if (!preview) return { title: `New mail in ${notice.mailbox}`, body: `Open ${notice.workspace} in HelloBox to read it.` };
  return {
    title: `${notice.fromName || notice.fromAddress} → ${notice.mailbox}`,
    body: `${notice.subject || "(no subject)"}${notice.excerpt ? `\n${notice.excerpt}` : ""}`,
  };
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return postToPublicUrl(url, JSON.stringify(body), { "Content-Type": "application/json", "User-Agent": "HelloBox-Notifications/1.0", ...headers });
}

function fail(status: number, body: string): never {
  throw new Error(`HTTP ${status}${body ? `: ${clip(body, 200)}` : ""}`);
}

async function toDiscord(url: string, notice: Notice, preview: boolean) {
  const { title, body } = plainText(notice, preview);
  const single = notice.count === 1 && preview;
  const res = await post(url, {
    username: "HelloBox",
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: clip(single ? notice.subject || "(no subject)" : title, 256),
        url: notice.url,
        description: clip(single ? notice.excerpt : body, 4000) || undefined,
        author: single ? { name: clip(sender(notice), 256) } : undefined,
        color: 0x7c86ff,
        footer: { text: clip(notice.count > 1 ? notice.workspace : `To ${notice.mailbox} · ${notice.workspace}`, 2048) },
        timestamp: notice.receivedAt,
      },
    ],
  });
  if (res.status === 401 || res.status === 404) throw new ChannelGone("The Discord webhook was deleted");
  if (res.status >= 300) fail(res.status, res.body);
}

const slackEscape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function toSlack(url: string, notice: Notice, preview: boolean) {
  const { title, body } = plainText(notice, preview);
  const single = notice.count === 1 && preview;
  const text = single
    ? `*<${notice.url}|${slackEscape(notice.subject || "(no subject)")}>*\nFrom ${slackEscape(sender(notice))} to ${slackEscape(notice.mailbox)}${notice.excerpt ? `\n>${slackEscape(notice.excerpt).replace(/\n/g, "\n>")}` : ""}`
    : `*<${notice.url}|${slackEscape(title)}>*\n${slackEscape(body)}`;
  const res = await post(url, { text: single ? `${notice.fromName || notice.fromAddress}: ${notice.subject}` : title, blocks: [{ type: "section", text: { type: "mrkdwn", text: clip(text, 2900) } }] });
  if (res.status === 404 || res.status === 410 || /no_service|channel_not_found|invalid_token|channel_is_archived/.test(res.body)) {
    throw new ChannelGone("The Slack app was removed or its channel is gone");
  }
  if (res.status >= 300) fail(res.status, res.body);
}

const html = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function telegramCall(method: string, body: unknown) {
  const telegram = notificationEnv().telegram;
  if (!telegram) throw new Error("Telegram isn't set up on this server");
  const res = await fetch(`https://api.telegram.org/bot${telegram.token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const result = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
  return { status: res.status, ...result };
}

async function toTelegram(chatId: number, notice: Notice, preview: boolean) {
  const { title, body } = plainText(notice, preview);
  const res = await telegramCall("sendMessage", {
    chat_id: chatId,
    text: clip(`<b>${html(title)}</b>\n${html(body)}`, 4000),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    // Telegram only takes https links on buttons.
    reply_markup: notice.url.startsWith("https://") ? { inline_keyboard: [[{ text: "Open in HelloBox", url: notice.url }]] } : undefined,
  });
  if (res.status === 403 || /chat not found|bot was blocked|kicked/i.test(res.description ?? "")) {
    throw new ChannelGone("The HelloBox bot was blocked or removed from the chat");
  }
  if (!res.ok) fail(res.status, res.description ?? "");
}

async function toNtfy(config: Extract<ChannelConfig, { kind: "ntfy" }>, notice: Notice, preview: boolean) {
  const { title, body } = plainText(notice, preview);
  const ours = notificationEnv().ntfy;
  // Our own server needs our publishing token. Someone else's uses theirs, if any.
  const token = config.token ?? (ours && config.server === ours.url ? ours.token : undefined);
  const res = await post(
    `${config.server}/`,
    { topic: config.topic, title: clip(title, 250), message: clip(body, 3500), click: notice.url, tags: ["envelope"] },
    token ? { Authorization: `Bearer ${token}` } : {},
  );
  if (res.status === 401 || res.status === 403) throw new ChannelGone("The ntfy server refused our token");
  if (res.status >= 300) fail(res.status, res.body);
}

export const signWebhook = (secret: string, timestamp: string, body: string) =>
  `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;

async function toWebhook(config: Extract<ChannelConfig, { kind: "webhook" }>, notice: Notice, preview: boolean) {
  const body = JSON.stringify({
    event: notice.test ? "test" : "message.received",
    workspace: notice.workspace,
    mailbox: notice.mailbox,
    count: notice.count,
    url: notice.url,
    receivedAt: notice.receivedAt,
    threadId: notice.threadId,
    messageId: notice.messageId,
    ...(preview
      ? { from: { name: notice.fromName, address: notice.fromAddress }, subject: notice.subject, excerpt: notice.excerpt, messages: notice.lines }
      : {}),
  });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const res = await postToPublicUrl(config.url, body, {
    "Content-Type": "application/json",
    "User-Agent": "HelloBox-Webhooks/1.0",
    "X-HelloBox-Timestamp": timestamp,
    "X-HelloBox-Signature": signWebhook(config.secret, timestamp, body),
  });
  if (res.status === 410) throw new ChannelGone("The webhook answered 410 Gone");
  if (res.status >= 300) fail(res.status, res.body);
}

async function toBrowser(subscription: PushSubscription, notice: Notice, preview: boolean) {
  const vapid = notificationEnv().vapid;
  if (!vapid) throw new Error("Browser notifications aren't set up on this server");
  const { title, body } = plainText(notice, preview);
  try {
    await webpush.sendNotification(
      subscription,
      JSON.stringify({ title, body: clip(body, 300), url: notice.url, tag: notice.threadId ?? "hellobox" }),
      { vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey }, TTL: 3600, timeout: 10_000 },
    );
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 404 || status === 410) throw new ChannelGone("This browser stopped accepting notifications");
    throw error;
  }
}

async function toEmail(to: string, notice: Notice, preview: boolean) {
  const { title } = plainText(notice, preview);
  await sendAppEmail({
    to,
    subject: notice.test ? "Test notification from HelloBox" : title,
    react: createElement(NewMail, {
      workspace: notice.workspace,
      url: notice.url,
      count: notice.count,
      details: preview
        ? notice.count > 1
          ? (notice.lines ?? []).slice(0, 10)
          : [{ from: sender(notice), subject: notice.subject, mailbox: notice.mailbox, excerpt: notice.excerpt }]
        : null,
      mailbox: notice.mailbox,
    }),
  });
}

/** Sends one notice. Throws ChannelGone when the destination is gone for good. */
export async function deliver(config: ChannelConfig, notice: Notice, { preview, email }: { preview: boolean; email: string }) {
  switch (config.kind) {
    case "discord":
      return toDiscord(config.url, notice, preview);
    case "slack":
      return toSlack(config.url, notice, preview);
    case "telegram":
      return toTelegram(config.chatId, notice, preview);
    case "ntfy":
      return toNtfy(config, notice, preview);
    case "webhook":
      return toWebhook(config, notice, preview);
    case "browser":
      return toBrowser(config.subscription, notice, preview);
    case "email":
      return toEmail(email, notice, preview);
  }
}
