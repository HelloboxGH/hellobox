import { connections, domains, getDb, mailboxes, supportConversations, supportInboxes, supportKeys, workspaces } from "@hellobox/db";
import {
  assertPublicUrl, cleanLine, generateSupportKey, generateWebhookSecret, sealWebhookSecret, setSupportStatus, SUPPORT_STATUSES, supportInboxProblem, UnsafeUrlError,
} from "@hellobox/mail";
import { and, count, eq, inArray, isNull } from "drizzle-orm";
import { badRequest, forbidden, notFound } from "nezt";
import { z } from "zod";
import { adminAction, workspaceAction } from "../builder";
import { emit } from "../events";
import type { WorkspaceContext } from "../middlewares";
import { assertThreads } from "./threads";

const MAX_INBOXES = 20;
const MAX_KEYS = 20;

const name = z.string().max(60).transform(cleanLine).refine((value) => value.length > 0, "Give it a name");

// A key lets a server in, so only a person makes one.
function assertPerson(ctx: WorkspaceContext) {
  if (ctx.agent) throw forbidden("Agents can't manage support inboxes");
}

async function ownInbox(ctx: WorkspaceContext, id: string) {
  const [inbox] = await getDb()
    .select()
    .from(supportInboxes)
    .where(and(eq(supportInboxes.id, id), eq(supportInboxes.workspaceId, ctx.workspace.id)));
  if (!inbox) throw notFound("Support inbox not found");
  return inbox;
}

// Every shared mailbox with why it can't take support messages, if it can't.
async function sharedMailboxes(workspaceId: string) {
  const rows = await getDb()
    .select({
      mailbox: mailboxes,
      domain: domains,
      connectionStatus: connections.status,
      workspace: { id: workspaces.id, suspendedAt: workspaces.suspendedAt, storageBytesUsed: workspaces.storageBytesUsed },
    })
    .from(mailboxes)
    .innerJoin(workspaces, eq(workspaces.id, mailboxes.workspaceId))
    .leftJoin(domains, eq(domains.id, mailboxes.domainId))
    .leftJoin(connections, eq(connections.id, domains.connectionId))
    .where(and(eq(mailboxes.workspaceId, workspaceId), eq(mailboxes.isCatchAll, false)))
    .orderBy(mailboxes.address);
  return rows.map((row) => ({ row, problem: supportInboxProblem(row) }));
}

export const listSupportInboxes = adminAction("/support/inboxes").handler(async ({ ctx }) => {
  const db = getDb();
  const [inboxes, keys, boxes, conversations] = await Promise.all([
    db.select().from(supportInboxes).where(eq(supportInboxes.workspaceId, ctx.workspace.id)).orderBy(supportInboxes.createdAt),
    db
      .select({ id: supportKeys.id, inboxId: supportKeys.inboxId, name: supportKeys.name, prefix: supportKeys.prefix, lastUsedAt: supportKeys.lastUsedAt, createdAt: supportKeys.createdAt })
      .from(supportKeys)
      .where(and(eq(supportKeys.workspaceId, ctx.workspace.id), isNull(supportKeys.revokedAt)))
      .orderBy(supportKeys.createdAt),
    sharedMailboxes(ctx.workspace.id),
    db
      .select({ inboxId: supportConversations.inboxId, count: count() })
      .from(supportConversations)
      .where(eq(supportConversations.workspaceId, ctx.workspace.id))
      .groupBy(supportConversations.inboxId),
  ]);
  return {
    inboxes: inboxes.map((inbox) => {
      const box = boxes.find(({ row }) => row.mailbox.id === inbox.mailboxId);
      return {
        id: inbox.id,
        name: inbox.name,
        address: box?.row.mailbox.address ?? null,
        domain: box?.row.domain?.name ?? null,
        receiving: Boolean(box?.row.domain?.receivingEnabled),
        problem: box ? box.problem : "This mailbox is gone",
        conversations: conversations.find((row) => row.inboxId === inbox.id)?.count ?? 0,
        sites: inbox.allowedOrigins,
        webhook: inbox.webhookUrl
          ? { url: inbox.webhookUrl, error: inbox.webhookError, pausedUntil: inbox.webhookPausedUntil }
          : null,
        keys: keys.filter((key) => key.inboxId === inbox.id).map(({ inboxId: _inboxId, ...key }) => key),
      };
    }),
    mailboxes: boxes
      .filter(({ problem }) => !problem)
      .map(({ row }) => ({ id: row.mailbox.id, address: row.mailbox.address })),
  };
});

export const createSupportInbox = adminAction("/support/inboxes/create")
  .input(z.object({ mailboxId: z.string(), name }))
  .handler(async ({ input, ctx }) => {
    assertPerson(ctx);
    const box = (await sharedMailboxes(ctx.workspace.id)).find(({ row }) => row.mailbox.id === input.mailboxId);
    if (!box) throw notFound("Mailbox not found");
    if (box.problem) throw badRequest(box.problem);
    const db = getDb();
    const [existing] = await db.select({ count: count() }).from(supportInboxes).where(eq(supportInboxes.workspaceId, ctx.workspace.id));
    if ((existing?.count ?? 0) >= MAX_INBOXES) throw badRequest(`A workspace can have up to ${MAX_INBOXES} support inboxes`);
    const [created] = await db
      .insert(supportInboxes)
      .values({ workspaceId: ctx.workspace.id, mailboxId: input.mailboxId, name: input.name })
      .returning({ id: supportInboxes.id });
    if (!created) throw new Error("Could not create the support inbox");
    await emit(ctx, "support.inbox_created", created.id, { name: input.name, mailbox: box.row.mailbox.address });
    return created;
  });

export const renameSupportInbox = adminAction("/support/inboxes/rename")
  .input(z.object({ id: z.string(), name }))
  .handler(async ({ input, ctx }) => {
    assertPerson(ctx);
    await ownInbox(ctx, input.id);
    await getDb().update(supportInboxes).set({ name: input.name }).where(eq(supportInboxes.id, input.id));
    return { ok: true };
  });

// Its conversations stay as mail. What made them support (customer, status, keys) goes.
export const deleteSupportInbox = adminAction("/support/inboxes/delete")
  .input(z.object({ id: z.string() }))
  .handler(async ({ input, ctx }) => {
    assertPerson(ctx);
    const inbox = await ownInbox(ctx, input.id);
    await getDb().delete(supportInboxes).where(eq(supportInboxes.id, inbox.id));
    await emit(ctx, "support.inbox_deleted", inbox.id, { name: inbox.name });
    return { ok: true };
  });

// The key is returned once, here. Only its hash is stored.
export const createSupportKey = adminAction("/support/keys/create")
  .input(z.object({ inboxId: z.string(), name }))
  .handler(async ({ input, ctx }) => {
    assertPerson(ctx);
    const inbox = await ownInbox(ctx, input.inboxId);
    const db = getDb();
    const [active] = await db
      .select({ count: count() })
      .from(supportKeys)
      .where(and(eq(supportKeys.inboxId, inbox.id), isNull(supportKeys.revokedAt)));
    if ((active?.count ?? 0) >= MAX_KEYS) throw badRequest(`An inbox can have up to ${MAX_KEYS} keys. Revoke one first`);
    const { key, hash, prefix } = generateSupportKey();
    const [created] = await db
      .insert(supportKeys)
      .values({ workspaceId: ctx.workspace.id, inboxId: inbox.id, name: input.name, keyHash: hash, prefix, createdBy: ctx.user.id })
      .returning({ id: supportKeys.id, name: supportKeys.name });
    if (!created) throw new Error("Could not create the key");
    await emit(ctx, "support.key_created", created.id, { name: created.name, inbox: inbox.name });
    return { ...created, key };
  });

export const revokeSupportKey = adminAction("/support/keys/revoke")
  .input(z.object({ id: z.string() }))
  .handler(async ({ input, ctx }) => {
    assertPerson(ctx);
    const [revoked] = await getDb()
      .update(supportKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(supportKeys.id, input.id), eq(supportKeys.workspaceId, ctx.workspace.id), isNull(supportKeys.revokedAt)))
      .returning({ id: supportKeys.id, name: supportKeys.name });
    if (!revoked) throw notFound("Key not found");
    await emit(ctx, "support.key_revoked", revoked.id, { name: revoked.name });
    return { ok: true };
  });

// For anyone who can read the conversations.
export const setStatus = workspaceAction("/support/status")
  .input(z.object({ threadIds: z.array(z.string()).min(1).max(100), status: z.enum(SUPPORT_STATUSES) }))
  .handler(async ({ input, ctx }) => {
    await assertThreads(ctx, input.threadIds);
    const rows = await getDb()
      .select({ id: supportConversations.id })
      .from(supportConversations)
      .where(inArray(supportConversations.threadId, input.threadIds));
    if (rows.length !== new Set(input.threadIds).size) throw badRequest("Only support conversations have a status");
    const changed = await setSupportStatus(rows.map((row) => row.id), input.status);
    return { updated: changed.length };
  });

// Replacing the address keeps the secret, so the app doesn't need a new one.
export const setSupportWebhook = adminAction("/support/webhook")
  .input(z.object({ inboxId: z.string(), url: z.string().trim().max(2000).nullable() }))
  .handler(async ({ input, ctx }) => {
    assertPerson(ctx);
    const inbox = await ownInbox(ctx, input.inboxId);
    let url: string | null = null;
    if (input.url) {
      try {
        url = assertPublicUrl(input.url).toString();
      } catch (error) {
        if (error instanceof UnsafeUrlError) throw badRequest(error.message);
        throw error;
      }
    }
    const secret = url && !inbox.webhookSecretEnc ? generateWebhookSecret() : null;
    await getDb()
      .update(supportInboxes)
      .set({
        webhookUrl: url,
        ...(secret ? { webhookSecretEnc: sealWebhookSecret(secret) } : {}),
        ...(url ? {} : { webhookSecretEnc: null }),
        webhookFailures: 0,
        webhookPausedUntil: null,
        webhookError: null,
      })
      .where(eq(supportInboxes.id, inbox.id));
    await emit(ctx, "support.webhook_changed", inbox.id, { name: inbox.name, url: url ?? "" });
    return { secret };
  });

// The old one stops working at once.
export const rollSupportWebhookSecret = adminAction("/support/webhook/secret")
  .input(z.object({ inboxId: z.string() }))
  .handler(async ({ input, ctx }) => {
    assertPerson(ctx);
    const inbox = await ownInbox(ctx, input.inboxId);
    if (!inbox.webhookUrl) throw badRequest("Add a webhook address first");
    const secret = generateWebhookSecret();
    await getDb().update(supportInboxes).set({ webhookSecretEnc: sealWebhookSecret(secret) }).where(eq(supportInboxes.id, inbox.id));
    await emit(ctx, "support.webhook_changed", inbox.id, { name: inbox.name, url: inbox.webhookUrl });
    return { secret };
  });

const MAX_SITES = 10;

// A site as the browser names it in frame-ancestors: https, or a local address while testing.
export function siteOrigin(value: string) {
  let url: URL;
  try {
    url = new URL(value.includes("://") ? value : `https://${value}`);
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
  if (url.username || url.password || !url.hostname.includes(".") && !local) return null;
  return url.origin;
}

// Only these sites may show the hosted page in a frame. Opening it as a page always works.
export const setSupportSites = adminAction("/support/sites")
  .input(z.object({ inboxId: z.string(), sites: z.array(z.string().trim().max(300)).max(MAX_SITES) }))
  .handler(async ({ input, ctx }) => {
    assertPerson(ctx);
    const inbox = await ownInbox(ctx, input.inboxId);
    const origins: string[] = [];
    for (const site of input.sites.filter(Boolean)) {
      const origin = siteOrigin(site);
      if (!origin) throw badRequest(`${site} isn't a site address. Use one like https://app.example.com`);
      if (!origins.includes(origin)) origins.push(origin);
    }
    await getDb().update(supportInboxes).set({ allowedOrigins: origins }).where(eq(supportInboxes.id, inbox.id));
    await emit(ctx, "support.sites_changed", inbox.id, { name: inbox.name, sites: origins.join(" ") });
    return { sites: origins };
  });

export const supportActions = {
  "/support/sites": setSupportSites,
  "/support/webhook": setSupportWebhook,
  "/support/webhook/secret": rollSupportWebhookSecret,
  "/support/inboxes": listSupportInboxes,
  "/support/inboxes/create": createSupportInbox,
  "/support/inboxes/rename": renameSupportInbox,
  "/support/inboxes/delete": deleteSupportInbox,
  "/support/keys/create": createSupportKey,
  "/support/keys/revoke": revokeSupportKey,
  "/support/status": setStatus,
};
