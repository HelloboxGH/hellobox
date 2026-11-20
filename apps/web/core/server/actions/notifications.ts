import { randomBytes } from "node:crypto";
import {
  getDb, mailboxes, notificationChannels, notificationSettings, threadNotes, threads, user, userNotifications,
} from "@hellobox/db";
import {
  addChannel, checkDiscordUrl, claimTestSend, checkSlackUrl, createTelegramLink, latestChannels, notificationEnv, openConfig,
  readableMailboxIds, UnsafeUrlError, assertPublicUrl,
} from "@hellobox/mail";
import { enqueueNotifyTest } from "@hellobox/queue";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { badRequest, forbidden, notFound } from "nezt";
import { z } from "zod";
import { safeAvatarUrl } from "@/core/avatar";
import { workspaceAction } from "../builder";
import type { WorkspaceContext } from "../middlewares";

// Where someone hears about new mail is their own business: agents can't change it.
function assertPerson(ctx: WorkspaceContext) {
  if (ctx.agent) throw forbidden("Agents can't change notification settings");
}

const MAX_CHANNELS = 20;

async function assertRoom(ctx: WorkspaceContext) {
  const rows = await latestChannels(ctx.workspace.id, ctx.user.id);
  if (rows.length >= MAX_CHANNELS) throw badRequest(`You can have up to ${MAX_CHANNELS} notification channels`);
  return rows;
}

const checked = <T>(work: () => T) => {
  try {
    return work();
  } catch (error) {
    if (error instanceof UnsafeUrlError) throw badRequest(error.message);
    throw error;
  }
};

async function ownChannel(ctx: WorkspaceContext, id: string) {
  const [row] = await getDb()
    .select()
    .from(notificationChannels)
    .where(
      and(
        eq(notificationChannels.id, id),
        eq(notificationChannels.workspaceId, ctx.workspace.id),
        eq(notificationChannels.userId, ctx.user.id),
      ),
    );
  if (!row) throw notFound("Notification channel");
  return row;
}

// What Settings shows: never the webhook URLs or tokens themselves.
function describe(row: typeof notificationChannels.$inferSelect) {
  const config = openConfig(row.configEnc);
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    preview: row.preview,
    enabled: row.enabled,
    disabledReason: row.disabledReason,
    lastSentAt: row.lastSentAt,
    createdAt: row.createdAt,
    ntfy: config.kind === "ntfy" ? { server: config.server, topic: config.topic } : null,
    endpoint: config.kind === "browser" ? config.subscription.endpoint : null,
  };
}

export const getNotifications = workspaceAction("/notifications/get").handler(async ({ ctx }) => {
  const db = getDb();
  const readable = await readableMailboxIds(ctx.workspace.id, ctx.user.id);
  const [rows, [setting], boxes] = await Promise.all([
    latestChannels(ctx.workspace.id, ctx.user.id),
    db
      .select()
      .from(notificationSettings)
      .where(and(eq(notificationSettings.workspaceId, ctx.workspace.id), eq(notificationSettings.userId, ctx.user.id))),
    readable.length
      ? db.select({ id: mailboxes.id, address: mailboxes.address }).from(mailboxes).where(and(inArray(mailboxes.id, readable), eq(mailboxes.isCatchAll, false))).orderBy(mailboxes.address)
      : Promise.resolve([]),
  ]);
  const env = notificationEnv();
  return {
    channels: rows.map(describe),
    settings: {
      mailboxIds: setting?.mailboxIds ?? null,
      primaryOnly: setting?.primaryOnly ?? false,
      teamEmails: setting?.teamEmails ?? true,
    },
    // Assignments only exist on paid plans, so the free plan has no team emails to set.
    teamEmails: ctx.entitlements.features.team,
    mailboxes: boxes,
    instantEmail: ctx.entitlements.features.instantEmail,
    available: {
      discord: !!env.discord,
      slack: !!env.slack,
      telegram: !!env.telegram?.username,
      browser: env.vapidPublicKey,
      ntfy: env.ntfy?.url ?? null,
    },
  };
});

export const updateNotificationSettings = workspaceAction("/notifications/settings")
  .input(z.object({ mailboxIds: z.array(z.string()).max(500).nullable(), primaryOnly: z.boolean() }))
  .handler(async ({ input, ctx }) => {
    assertPerson(ctx);
    const readable = new Set(await readableMailboxIds(ctx.workspace.id, ctx.user.id));
    const mailboxIds = input.mailboxIds ? input.mailboxIds.filter((id) => readable.has(id)) : null;
    await getDb()
      .insert(notificationSettings)
      .values({ workspaceId: ctx.workspace.id, userId: ctx.user.id, mailboxIds, primaryOnly: input.primaryOnly })
      .onConflictDoUpdate({
        target: [notificationSettings.workspaceId, notificationSettings.userId],
        set: { mailboxIds, primaryOnly: input.primaryOnly },
      });
    return { ok: true };
  });

export const updateTeamEmails = workspaceAction("/notifications/team-emails")
  .input(z.object({ enabled: z.boolean() }))
  .handler(async ({ input, ctx }) => {
    assertPerson(ctx);
    await getDb()
      .insert(notificationSettings)
      .values({ workspaceId: ctx.workspace.id, userId: ctx.user.id, teamEmails: input.enabled })
      .onConflictDoUpdate({
        target: [notificationSettings.workspaceId, notificationSettings.userId],
        set: { teamEmails: input.enabled },
      });
    return { ok: true };
  });

// In-app notifications: what teammates did that this person should see, newest first.
// Ones about conversations they can no longer read are left out.
const INBOX_SIZE = 30;

export const listInboxNotifications = workspaceAction("/notifications/inbox").handler(async ({ ctx }) => {
  const db = getDb();
  const readable = await readableMailboxIds(ctx.workspace.id, ctx.user.id);
  if (!readable.length) return { items: [] };
  const rows = await db
    .select({
      id: userNotifications.id,
      kind: userNotifications.kind,
      threadId: userNotifications.threadId,
      readAt: userNotifications.readAt,
      createdAt: userNotifications.createdAt,
      subject: threads.subject,
      note: threadNotes.body,
      actorName: user.name,
      actorImage: user.image,
    })
    .from(userNotifications)
    .innerJoin(threads, eq(threads.id, userNotifications.threadId))
    .leftJoin(user, eq(user.id, userNotifications.actorId))
    .leftJoin(threadNotes, eq(threadNotes.id, userNotifications.noteId))
    .where(
      and(
        eq(userNotifications.workspaceId, ctx.workspace.id),
        eq(userNotifications.userId, ctx.user.id),
        inArray(threads.mailboxId, readable),
      ),
    )
    .orderBy(desc(userNotifications.createdAt))
    .limit(INBOX_SIZE);
  return {
    items: rows.map(({ actorName, actorImage, ...row }) => ({
      ...row,
      actor: actorName === null ? null : { name: actorName, image: safeAvatarUrl(actorImage) },
    })),
  };
});

export const readInboxNotifications = workspaceAction("/notifications/inbox/read")
  .input(z.object({ ids: z.array(z.string()).max(100).optional() }))
  .handler(async ({ input, ctx }) => {
    await getDb()
      .update(userNotifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(userNotifications.workspaceId, ctx.workspace.id),
          eq(userNotifications.userId, ctx.user.id),
          isNull(userNotifications.readAt),
          input.ids ? inArray(userNotifications.id, input.ids) : undefined,
        ),
      );
    return { ok: true };
  });

const pushSubscription = z.object({
  endpoint: z.url().max(2000),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
});

export const addNotificationChannel = workspaceAction("/notifications/channels/add")
  .input(
    z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("email") }),
      z.object({ kind: z.literal("discord"), url: z.string().max(500) }),
      z.object({ kind: z.literal("slack"), url: z.string().max(500) }),
      z.object({ kind: z.literal("webhook"), url: z.string().max(1000) }),
      z.object({
        kind: z.literal("ntfy"),
        server: z.string().max(300).optional(),
        topic: z.string().regex(/^[\w-]{1,64}$/, "Topics use letters, numbers, - and _").optional(),
        token: z.string().max(200).optional(),
      }),
      z.object({ kind: z.literal("browser"), subscription: pushSubscription, device: z.string().max(80) }),
    ]),
  )
  .handler(async ({ input, ctx }) => {
    assertPerson(ctx);
    const existing = await assertRoom(ctx);
    const base = { workspaceId: ctx.workspace.id, userId: ctx.user.id, preview: true };
    switch (input.kind) {
      case "email": {
        if (existing.some((row) => row.kind === "email")) throw badRequest("Email notifications are already on");
        const id = await addChannel({ ...base, label: `Email · ${ctx.user.email}`, config: { kind: "email" } });
        return { id, secret: null };
      }
      case "discord": {
        const url = checked(() => checkDiscordUrl(input.url));
        return { id: await addChannel({ ...base, label: "Discord channel", config: { kind: "discord", url } }), secret: null };
      }
      case "slack": {
        const url = checked(() => checkSlackUrl(input.url));
        return { id: await addChannel({ ...base, label: "Slack channel", config: { kind: "slack", url } }), secret: null };
      }
      case "webhook": {
        const url = checked(() => assertPublicUrl(input.url.trim())).toString();
        const secret = `whsec_${randomBytes(24).toString("base64url")}`;
        const id = await addChannel({ ...base, label: `Webhook · ${new URL(url).host}`, config: { kind: "webhook", url, secret } });
        // Shown once. Only the encrypted copy stays with us.
        return { id, secret };
      }
      case "ntfy": {
        const ours = notificationEnv().ntfy?.url;
        const server = input.server?.trim() ? checked(() => assertPublicUrl(input.server!.trim())).toString().replace(/\/$/, "") : ours;
        if (!server) throw badRequest("Enter your ntfy server's address");
        const topic = input.topic || `hb-${randomBytes(18).toString("base64url").replace(/[^\w]/g, "x")}`;
        // Topics on a shared server are readable by anyone who knows them, so previews start off.
        const id = await addChannel({
          ...base,
          preview: false,
          label: `ntfy · ${new URL(server).host}/${topic.slice(0, 12)}…`,
          config: { kind: "ntfy", server, topic, token: input.token?.trim() || undefined },
        });
        return { id, secret: null };
      }
      case "browser": {
        if (!notificationEnv().vapidPublicKey) throw badRequest("Browser notifications aren't set up on this server");
        checked(() => assertPublicUrl(input.subscription.endpoint));
        // The same browser subscribing again replaces its old entry.
        for (const row of existing.filter((r) => r.kind === "browser")) {
          const config = openConfig(row.configEnc);
          if (config.kind === "browser" && config.subscription.endpoint === input.subscription.endpoint) {
            await getDb().delete(notificationChannels).where(eq(notificationChannels.id, row.id));
          }
        }
        const id = await addChannel({
          ...base,
          label: `Browser · ${input.device || "this device"}`,
          config: { kind: "browser", subscription: input.subscription },
        });
        return { id, secret: null };
      }
    }
  });

export const updateNotificationChannel = workspaceAction("/notifications/channels/update")
  .input(z.object({ id: z.string(), enabled: z.boolean().optional(), preview: z.boolean().optional(), label: z.string().trim().min(1).max(120).optional() }))
  .handler(async ({ input, ctx }) => {
    assertPerson(ctx);
    await ownChannel(ctx, input.id);
    await getDb()
      .update(notificationChannels)
      .set({
        ...(input.enabled !== undefined ? { enabled: input.enabled, ...(input.enabled ? { failures: 0, disabledReason: null } : {}) } : {}),
        ...(input.preview !== undefined ? { preview: input.preview } : {}),
        ...(input.label ? { label: input.label } : {}),
      })
      .where(eq(notificationChannels.id, input.id));
    return { ok: true };
  });

export const removeNotificationChannel = workspaceAction("/notifications/channels/remove")
  .input(z.object({ id: z.string() }))
  .handler(async ({ input, ctx }) => {
    assertPerson(ctx);
    await ownChannel(ctx, input.id);
    await getDb().delete(notificationChannels).where(eq(notificationChannels.id, input.id));
    return { ok: true };
  });

// The worker sends it, so the web app never holds the tokens that publish.
export const testNotificationChannel = workspaceAction("/notifications/channels/test")
  .input(z.object({ id: z.string() }))
  .handler(async ({ input, ctx }) => {
    assertPerson(ctx);
    const channel = await ownChannel(ctx, input.id);
    const refused = await claimTestSend(channel);
    if (refused) throw badRequest(refused);
    await enqueueNotifyTest(input.id);
    return { ok: true };
  });

export const linkTelegram = workspaceAction("/notifications/telegram/link").handler(async ({ ctx }) => {
  assertPerson(ctx);
  await assertRoom(ctx);
  try {
    return await createTelegramLink(ctx.workspace.id, ctx.user.id);
  } catch {
    throw badRequest("Telegram isn't set up on this server");
  }
});

export const notificationActions = {
  "/notifications/get": getNotifications,
  "/notifications/settings": updateNotificationSettings,
  "/notifications/team-emails": updateTeamEmails,
  "/notifications/inbox": listInboxNotifications,
  "/notifications/inbox/read": readInboxNotifications,
  "/notifications/channels/add": addNotificationChannel,
  "/notifications/channels/update": updateNotificationChannel,
  "/notifications/channels/remove": removeNotificationChannel,
  "/notifications/channels/test": testNotificationChannel,
  "/notifications/telegram/link": linkTelegram,
};
