import { createHash, randomBytes } from "node:crypto";
import type { CloudBootstrap } from "@ext/server";
import { safeLogoUrl } from "@/core/avatar";
import { getExtensions } from "@/core/extensions";
import { decrypt, getEnv, isAwsBrokerConfigured, isCloudflareConfigured } from "@hellobox/config";
import {
  campaigns,
  contacts,
  dnsConnections,
  domains,
  emailTemplates,
  getDb,
  invitations,
  labels,
  mailboxes,
  mailboxMembers,
  members,
  messages,
  connections,
  rules,
  senderLists,
  supportConversations,
  supportInboxes,
  threads,
  threadUserState,
  user,
  userNotifications,
  workspaces,
} from "@hellobox/db";


import {
  claimConflict,
  claimConflictMessage,
  countedDomainNames,
  domainClaims,
  incomingTakeovers,
  lockDomainName,
  outgoingTakeovers,
  fitsPlan,
  helloboxMxHost,
  isCommonMailDomain,
  parseBlockTarget,
  planDomainCount,
  removeMailbox,
  restoreDomain,
  listSuppressions,
  removeSuppression,
  setMailgunReceiving,
  setPostmarkReceiving,
  setSesReceiving,
  shareWithAdmins,
  successorFor,
  syncDomains,
  tearDownConnection,
} from "@hellobox/mail";
import { RoleAccessError } from "@hellobox/providers";
import { clientEntitlements, entitlements, fullWorkspaceError, requireFeature, requireRoom, roomError } from "../entitlements";
import { clearMemberAccess } from "./workspaces";
import { revokeGrant } from "@hellobox/resend";
import { and, desc, eq, getTableColumns, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { badRequest, conflict, forbidden, notFound } from "nezt";
import { createElement } from "react";
import { z } from "zod";
import { sendAppEmail, WorkspaceInvite } from "@hellobox/email";
import { adminAction, userAction, workspaceAction } from "../builder";
import { emit } from "../events";
import {
  accessibleMailboxIds,
  type WorkspaceContext,
} from "../middlewares";
import { inInbox, notSupport, onShownDomain } from "./threads";

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export const bootstrap = workspaceAction("/app/bootstrap").handler(async ({ ctx }) => {
  const db = getDb();
  // Cloud's slot catches the workspace up with its payment provider first, so the
  // entitlements below are read after it.
  const cloud = (await getExtensions().bootstrap?.(ctx)) ?? {};
  const workspace = ctx.workspace;
  const allowed = await accessibleMailboxIds(ctx);
  const accountQuery = db
    .select({ onboardedAt: user.onboardedAt, showWorkspaceUnread: user.showWorkspaceUnread })
    .from(user)
    .where(eq(user.id, ctx.user.id))
    .execute();
  const [[account], myWorkspaces, workspaceUnread, connectionRows, domainRows, mailboxRows, labelRows, counts, managedRows, [cloudflare], outgoingClaims, incomingClaims, [notices], [supportInbox], [openSupport]] =
    await Promise.all([
      accountQuery,
      db
        .select({ id: workspaces.id, name: workspaces.name, logo: workspaces.logo, role: members.role })
        .from(members)
        .innerJoin(workspaces, eq(workspaces.id, members.workspaceId))
        .where(eq(members.userId, ctx.user.id)),
      // Inbox unread for every workspace in the switcher, in one query: the same filters as the
      // Inbox count below, over the mailboxes this person reads in each (see readableMailboxIds).
      accountQuery.then(([row]) =>
        row?.showWorkspaceUnread
          ? db
              .select({ workspaceId: threads.workspaceId, unread: sql<number>`count(*)::int` })
              .from(threads)
              .innerJoin(members, and(eq(members.workspaceId, threads.workspaceId), eq(members.userId, ctx.user.id)))
              .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
              .leftJoin(domains, eq(domains.id, mailboxes.domainId))
              .leftJoin(
                mailboxMembers,
                and(eq(mailboxMembers.mailboxId, mailboxes.id), eq(mailboxMembers.userId, ctx.user.id)),
              )
              .leftJoin(
                threadUserState,
                and(eq(threadUserState.threadId, threads.id), eq(threadUserState.userId, ctx.user.id)),
              )
              .where(
                and(
                  or(
                    eq(mailboxes.personalUserId, ctx.user.id),
                    and(isNull(mailboxes.personalUserId), isNotNull(mailboxMembers.userId)),
                  ),
                  onShownDomain(),
                  isNull(threadUserState.readAt),
                  inInbox(new Date()),
                  notSupport,
                ),
              )
              .groupBy(threads.workspaceId)
          : null,
      ),
      db
        .select({
          id: connections.id,
          status: connections.status,
          provider: connections.provider,
          config: connections.config,
          createdAt: connections.createdAt,
        })
        .from(connections)
        .where(eq(connections.workspaceId, ctx.workspace.id))
        .orderBy(connections.createdAt),
      db
        .select({
          ...getTableColumns(domains),
          // Settings says "Waiting for the first email" on a receiving domain until one arrives.
          // Written out with aliases: in a one-table select Drizzle prints columns without
          // their table, and every table here has an "id".
          hasMail: sql<boolean>`exists (
            select 1 from "mailboxes" mb
            join "threads" t on t."mailbox_id" = mb."id"
            join "messages" m on m."thread_id" = t."id"
            where mb."domain_id" = "domains"."id" and m."direction" = 'inbound'
          )`,
          // Another place has this domain on (see domainClaims), so it can't be turned on here.
          claimedElsewhere: sql<boolean>`exists (
            select 1 from "domains" other
            join "connections" oc on oc."id" = other."connection_id"
            where lower(rtrim(other."name", '.')) = lower(rtrim("domains"."name", '.'))
              and other."id" <> "domains"."id"
              and other."enabled" and other."removed_at" is null and other."status" = 'verified'
              and oc."provider" <> 'demo'
          )`,
        })
        .from(domains)
        .where(eq(domains.workspaceId, ctx.workspace.id))
        .orderBy(domains.name),
      allowed.length
        ? // Deleted mailboxes stay readable through `allowed`, but aren't listed or sent from.
          db
            .select()
            .from(mailboxes)
            // The unknown-recipients mailboxes only hold spam, which the Spam view shows.
            .where(and(inArray(mailboxes.id, allowed), isNull(mailboxes.removedAt), eq(mailboxes.isCatchAll, false)))
            .orderBy(mailboxes.address)
        : [],
      db.select().from(labels).where(eq(labels.workspaceId, ctx.workspace.id)).orderBy(labels.name),
      allowed.length
        ? db
            // Unread only, and only what the matching view lists.
            .select({
              inboxUnread: sql<number>`count(*) filter (where ${inInbox(new Date())} and ${notSupport})::int`,
              spam: sql<number>`count(*) filter (where ${threads.folder} = 'spam')::int`,
              starred: sql<number>`count(*) filter (where ${threadUserState.starred} and ${threads.folder} not in ('spam', 'trash'))::int`,
              assigned: sql<number>`count(*) filter (where ${threads.assignedTo} = ${ctx.user.id} and ${inInbox(new Date())})::int`,
              unassigned: sql<number>`count(*) filter (where ${threads.assignedTo} is null and ${mailboxes.personalUserId} is null and ${inInbox(new Date())})::int`,
            })
            .from(threads)
            .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
            .leftJoin(domains, eq(domains.id, mailboxes.domainId))
            .leftJoin(
              threadUserState,
              and(eq(threadUserState.threadId, threads.id), eq(threadUserState.userId, ctx.user.id)),
            )
            .where(and(inArray(threads.mailboxId, allowed), onShownDomain(), isNull(threadUserState.readAt)))
        : [],
      // Admins manage every mailbox's settings and access without reading the mail in it.
      ctx.role === "member"
        ? []
        : db
            .select({
              id: mailboxes.id,
              domainId: mailboxes.domainId,
              address: mailboxes.address,
              displayName: mailboxes.displayName,
              isCatchAll: mailboxes.isCatchAll,
              personalUserId: mailboxes.personalUserId,
            })
            .from(mailboxes)
            .where(and(eq(mailboxes.workspaceId, ctx.workspace.id), isNull(mailboxes.removedAt), eq(mailboxes.isCatchAll, false)))
            .orderBy(mailboxes.address),
      db
        .select({ connectedAt: dnsConnections.createdAt })
        .from(dnsConnections)
        .where(and(eq(dnsConnections.workspaceId, ctx.workspace.id), eq(dnsConnections.provider, "cloudflare"))),
      outgoingTakeovers(ctx.workspace.id),
      incomingTakeovers(ctx.workspace.id),
      // Unseen in-app notifications, on conversations this person can still read.
      allowed.length
        ? db
            .select({ unread: sql<number>`count(*)::int` })
            .from(userNotifications)
            .innerJoin(threads, eq(threads.id, userNotifications.threadId))
            .where(
              and(
                eq(userNotifications.workspaceId, ctx.workspace.id),
                eq(userNotifications.userId, ctx.user.id),
                isNull(userNotifications.readAt),
                inArray(threads.mailboxId, allowed),
              ),
            )
        : [],
      db.select({ id: supportInboxes.id }).from(supportInboxes).where(eq(supportInboxes.workspaceId, ctx.workspace.id)).limit(1),
      // Waiting for the team, read or not.
      allowed.length
        ? db
            .select({ count: sql<number>`count(*)::int` })
            .from(supportConversations)
            .innerJoin(threads, eq(threads.id, supportConversations.threadId))
            .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
            .leftJoin(domains, eq(domains.id, mailboxes.domainId))
            .where(
              and(
                inArray(threads.mailboxId, allowed),
                eq(supportConversations.status, "open"),
                sql`${threads.folder} not in ('spam', 'trash')`,
                onShownDomain(),
              ),
            )
        : [],
    ]);
  return {
    user: {
      ...ctx.user,
      onboardedAt: account?.onboardedAt ?? null,
      showWorkspaceUnread: account?.showWorkspaceUnread ?? true,
    },
    workspace: {
      id: workspace.id,
      name: workspace.name,
      logo: safeLogoUrl(workspace.logo),
      storageBytesUsed: workspace.storageBytesUsed,
      bouncesEnabled: workspace.bouncesEnabled,
      // Ends on its own (the hosted demo), so there's nothing to set up.
      expiring: Boolean(workspace.demoExpiresAt),
    },
    role: ctx.role,
    // What this workspace may do: no plan, limits or upgrade prompts when nothing is registered.
    entitlements: clientEntitlements(await entitlements(workspace.id)),
    // Whatever the cloud build's screens need on top; empty in the open build.
    cloud: cloud as CloudBootstrap,
    // `unread` is null when this person turned the counts off.
    workspaces: myWorkspaces.map((row) => ({
      ...row,
      logo: safeLogoUrl(row.logo),
      unread: workspaceUnread
        ? (workspaceUnread.find((count) => count.workspaceId === row.id)?.unread ?? 0)
        : null,
    })),
    // Only what the settings page shows. Role ARNs and topic ARNs stay on the server.
    connections: connectionRows.map(({ config, ...connection }) => ({
      ...connection,
      region: config.region ?? null,
      accountId: config.accountId ?? null,
      route53: config.route53 ?? false,
      receiving: Boolean(config.receiving),
      // Postmark: the server we send through, and its one receiving domain.
      serverName: config.postmark?.serverName ?? null,
      inboundDomain: config.postmark?.inboundDomain ?? null,
      // Postmark: receiving turned on, waiting for Postmark to see the MX record.
      pendingInboundDomain: config.postmark?.pendingInboundDomain ?? null,
      // Mailgun: the region its domains live in.
      mailgunRegion: config.mailgun?.region ?? null,
      // SMTP: the server, shown next to the connection. Never the username or password.
      smtpHost: config.smtp?.host ?? null,
      // SendGrid: the EU host, and whether it has our events webhook.
      sendgridRegion: config.sendgrid?.region ?? null,
      sendgridEvents: config.sendgrid?.events ?? null,
      // Brevo: whether it has our events webhook.
      brevoEvents: config.brevo?.events ?? null,
      // MailerSend: whether every domain has our events webhook.
      mailersendEvents: config.mailersend?.events ?? null,
      // Mailjet: whether every event type has our callback.
      mailjetEvents: config.mailjet?.events ?? null,
      // Bird: the region its key works on.
      birdRegion: config.bird?.region ?? null,
      // Bird: receiving asked for, waiting for the domain's DKIM.
      birdPending: config.bird?.pending ?? [],
      // Custom provider: the name its spec gives. The spec itself is read by admins only,
      // when they edit it.
      customName: typeof config.custom?.spec.name === "string" ? config.custom.spec.name : null,
      // Its description and logo, when the workspace gave them.
      customDescription: config.custom?.description ?? null,
      customLogo: safeLogoUrl(config.custom?.logo),
      // Whether its spec reads delivery events.
      customEvents: config.custom ? Boolean(config.custom.spec.events) : null,
    })),
    providers: { ses: isAwsBrokerConfigured(), cloudflare: isCloudflareConfigured() },
    // DNS hosts the workspace let us write records to.
    dnsHosts: { cloudflare: cloudflare ?? null },
    // HelloBox's own mail server, when this HelloBox runs one: domains can receive through it.
    helloboxMx: helloboxMxHost(),
    domains: domainRows,
    // Claims this workspace is making on other workspaces' domains, and claims on its own.
    domainClaims: {
      outgoing: ctx.role === "member" ? [] : outgoingClaims,
      incoming: ctx.role === "member" ? [] : incomingClaims,
    },
    mailboxes: mailboxRows,
    managedMailboxes: managedRows,
    labels: labelRows,
    counts: { ...(counts[0] ?? { inboxUnread: 0, spam: 0, starred: 0, assigned: 0, unassigned: 0 }), supportOpen: openSupport?.count ?? 0 },
    support: Boolean(supportInbox),
    notificationsUnread: notices?.unread ?? 0,
  };
});

export const setDomainEnabled = adminAction("/domains/set-enabled")
  .input(z.object({ id: z.string(), enabled: z.boolean() }))
  .handler(async ({ input, ctx }) => {
    const db = getDb();
    let domain: { name: string; status: string | null } | undefined;
    if (input.enabled) {
      [domain] = await db
        .select({ name: domains.name, status: domains.status })
        .from(domains)
        .where(and(eq(domains.id, input.id), eq(domains.workspaceId, ctx.workspace.id)));
      if (!domain) throw notFound("Domain");
      const counted = await countedDomainNames(ctx.workspace.id);
      // A subdomain of a domain that's on doesn't take a place.
      if (!fitsPlan(counted, domain.name, ctx.entitlements.limits.domains)) {
        throw roomError(ctx, "domains", planDomainCount(counted), "You've reached your plan's domain limit");
      }
    }
    const updated = await db.transaction(async (tx) => {
      // Only one place can have a domain on (see domainClaims).
      if (domain) {
        await lockDomainName(tx, domain.name);
        const taken = claimConflict(await domainClaims(tx, domain.name), { domainId: input.id, workspaceId: ctx.workspace.id });
        if (taken) throw conflict(claimConflictMessage(domain.name, taken, domain.status === "verified"));
      }
      const [row] = await tx
        .update(domains)
        .set({ enabled: input.enabled })
        .where(and(eq(domains.id, input.id), eq(domains.workspaceId, ctx.workspace.id), isNull(domains.removedAt)))
        .returning({ id: domains.id });
      return row;
    });
    if (!updated) throw notFound("Domain");
    return updated;
  });

// Removes a domain from HelloBox only: the identity stays in the provider account. Its
// mailboxes and mail stay. They move to the same domain on another connection when there
// is one; otherwise the mail stays readable and nothing new is sent from them.
export const removeDomain = adminAction("/domains/remove")
  .input(z.object({ id: z.string() }))
  .handler(async ({ input, ctx }) => {
    const db = getDb();
    const [domain] = await db
      .select({ domain: domains, connection: connections })
      .from(domains)
      .innerJoin(connections, eq(connections.id, domains.connectionId))
      .where(and(eq(domains.id, input.id), eq(domains.workspaceId, ctx.workspace.id), isNull(domains.removedAt)));
    if (!domain) throw notFound("Domain");
    const { name, connectionId, receivingEnabled } = domain.domain;

    // SES only sends us mail for the domains in our receipt rule, so this one leaves it.
    // A connection that isn't active has no rule we can reach.
    if (domain.connection.provider === "ses" && domain.connection.status === "active" && receivingEnabled) {
      const receiving = await db
        .select({ name: domains.name })
        .from(domains)
        .where(and(eq(domains.connectionId, connectionId), eq(domains.receivingEnabled, true), isNull(domains.removedAt)));
      try {
        await setSesReceiving(connectionId, ctx.workspace.id, receiving.map((row) => row.name).filter((n) => n !== name));
      } catch (error) {
        if (error instanceof RoleAccessError) throw badRequest(error.message);
        throw badRequest(`Couldn't turn off receiving for ${name} in Amazon SES: ${(error as Error).message}`);
      }
    }
    // A Postmark server receives for one domain, so this turns receiving off.
    if (domain.connection.provider === "postmark" && domain.connection.status === "active" && receivingEnabled) {
      try {
        await setPostmarkReceiving(connectionId, ctx.workspace.id, null);
      } catch (error) {
        throw badRequest(`Couldn't turn off receiving for ${name} in Postmark: ${(error as Error).message}`);
      }
    }
    // Mailgun's route for the domain goes, so it stops storing mail for us.
    if (domain.connection.provider === "mailgun" && domain.connection.status === "active" && receivingEnabled) {
      try {
        await setMailgunReceiving(connectionId, ctx.workspace.id, name, false);
      } catch (error) {
        throw badRequest(`Couldn't turn off receiving for ${name} in Mailgun: ${(error as Error).message}`);
      }
    }

    const candidates = await db
      .select({
        id: domains.id,
        name: domains.name,
        enabled: domains.enabled,
        removedAt: domains.removedAt,
        connectionStatus: connections.status,
      })
      .from(domains)
      .innerJoin(connections, eq(connections.id, domains.connectionId))
      .where(and(eq(domains.workspaceId, ctx.workspace.id), eq(domains.name, name)));
    const successor = successorFor({ id: input.id, name }, candidates);
    const moved = await db.transaction(async (tx) => {
      const rows = successor
        ? await tx
            .update(mailboxes)
            .set({ domainId: successor.id })
            .where(eq(mailboxes.domainId, input.id))
            .returning({ id: mailboxes.id })
        : [];
      await tx
        .update(domains)
        .set({ removedAt: new Date(), enabled: false, receivingEnabled: false })
        .where(eq(domains.id, input.id));
      return rows.length;
    });
    await emit(ctx, "domain.removed", name, {
      connectionId,
      provider: domain.connection.provider,
      mailboxesMovedTo: successor ? successor.id : null,
      mailboxesMoved: moved,
    });
    return { ok: true, movedTo: successor?.id ?? null, mailboxesMoved: moved };
  });

export const restoreRemovedDomain = adminAction("/domains/restore")
  .input(z.object({ id: z.string() }))
  .handler(async ({ input, ctx }) => {
    const result = await restoreDomain(input.id, ctx.workspace.id, ctx.entitlements.limits.domains);
    if (!result) throw notFound("Domain");
    const [domain] = await getDb().select({ name: domains.name }).from(domains).where(eq(domains.id, input.id));
    if (result.restored) await emit(ctx, "domain.restored", domain?.name, { enabled: result.enabled });
    return { enabled: result.enabled, offBecause: result.offBecause };
  });

export const resyncDomains = adminAction("/domains/sync")
  .handler(async ({ ctx }) => {
    const active = await getDb()
      .select({ id: connections.id })
      .from(connections)
      .where(
        and(eq(connections.workspaceId, ctx.workspace.id), eq(connections.status, "active")),
      );
    for (const connection of active) {
      await syncDomains(connection.id, ctx.workspace.id, ctx.entitlements.limits.domains);
    }
    return { ok: true };
  });

export const createMailbox = adminAction("/mailboxes/create")
  .input(z.object({ address: z.email(), displayName: z.string().max(100).optional() }))
  .handler(async ({ input, ctx }) => {
    const address = input.address.toLowerCase();
    const db = getDb();
    const name = address.slice(address.indexOf("@") + 1);
    const [domain] = await db
      .select()
      .from(domains)
      .where(and(eq(domains.workspaceId, ctx.workspace.id), eq(domains.name, name), isNull(domains.removedAt)))
      // The same domain can be on more than one connection. Use the one that's on.
      .orderBy(desc(domains.enabled))
      .limit(1);
    if (!domain) throw badRequest("Add this domain to a connected provider first");
    if (!domain.enabled) {
      throw roomError(
        ctx,
        "domains",
        planDomainCount(await countedDomainNames(ctx.workspace.id)),
        ctx.entitlements.prompts ? "This domain isn't active on your plan" : "Turn this domain on in Settings first",
      );
    }
    // Adding a deleted mailbox again brings it back with its mail and who could read it.
    const [restored] = await db
      .update(mailboxes)
      .set({ removedAt: null, domainId: domain.id, ...(input.displayName ? { displayName: input.displayName } : {}) })
      .where(and(eq(mailboxes.workspaceId, ctx.workspace.id), eq(mailboxes.address, address), isNotNull(mailboxes.removedAt)))
      .returning();
    if (restored) {
      await emit(ctx, "mailbox.restored", address);
      return restored;
    }
    // Imported before the domain was here: give it the domain. Who reads it stays the same,
    // so imported personal mail stays personal.
    const [adopted] = await db
      .update(mailboxes)
      .set({ domainId: domain.id, ...(input.displayName ? { displayName: input.displayName } : {}) })
      .where(and(eq(mailboxes.workspaceId, ctx.workspace.id), eq(mailboxes.address, address), isNull(mailboxes.domainId)))
      .returning();
    if (adopted) return adopted;
    const [mailbox] = await db
      .insert(mailboxes)
      .values({
        workspaceId: ctx.workspace.id,
        domainId: domain.id,
        address,
        displayName: input.displayName,
      })
      .onConflictDoNothing()
      .returning();
    if (!mailbox) throw conflict("This mailbox already exists");
    await shareWithAdmins(ctx.workspace.id, [mailbox.id]);
    return mailbox;
  });

export const updateMailbox = adminAction("/mailboxes/update")
  .input(z.object({ id: z.string(), displayName: z.string().max(100).nullable() }))
  .handler(async ({ input, ctx }) => {
    // The sender name is settings, not mail, so admins can change it on any mailbox.
    const [updated] = await getDb()
      .update(mailboxes)
      .set({ displayName: input.displayName })
      .where(and(eq(mailboxes.id, input.id), eq(mailboxes.workspaceId, ctx.workspace.id)))
      .returning({ id: mailboxes.id });
    if (!updated) throw notFound("Mailbox");
    return { ok: true };
  });

// Deletes a mailbox from HelloBox, keeping its conversations where they were readable.
// New mail to the address still arrives and is kept. See removeMailbox.
export const deleteMailbox = adminAction("/mailboxes/delete")
  .input(z.object({ id: z.string() }))
  .handler(async ({ input, ctx }) => {
    const removed = await removeMailbox(ctx.workspace.id, input.id);
    if (!removed) throw notFound("Mailbox");
    await emit(ctx, "mailbox.deleted", removed.address, { personal: Boolean(removed.personalUserId) });
    return { ok: true };
  });

// Making a mailbox personal takes it away from everyone else, admins included. Only its
// owner can make it shared again, so an admin can't take it back to read it.
export const setMailboxPersonal = workspaceAction("/mailboxes/set-personal")
  .input(z.object({ id: z.string(), userId: z.string().nullable() }))
  .handler(async ({ input, ctx }) => {
    const db = getDb();
    const [mailbox] = await db
      .select({ id: mailboxes.id, address: mailboxes.address, personalUserId: mailboxes.personalUserId, encrypted: mailboxes.encrypted })
      .from(mailboxes)
      .where(and(eq(mailboxes.id, input.id), eq(mailboxes.workspaceId, ctx.workspace.id)));
    if (!mailbox) throw notFound("Mailbox");

    if (input.userId === null) {
      if (mailbox.personalUserId !== ctx.user.id) {
        throw forbidden("Only the person this mailbox belongs to can share it");
      }
      // Teammates couldn't open mail sealed to this person's key.
      if (mailbox.encrypted) throw badRequest("Turn off encryption for this mailbox before sharing it");
      await db.update(mailboxes).set({ personalUserId: null }).where(eq(mailboxes.id, mailbox.id));
      await db.insert(mailboxMembers).values({ mailboxId: mailbox.id, userId: ctx.user.id }).onConflictDoNothing();
      await shareWithAdmins(ctx.workspace.id, [mailbox.id]);
      await emit(ctx, "mailbox.shared", mailbox.address);
      return { ok: true };
    }

    if (ctx.role === "member") throw forbidden("Only admins can do this");
    if (mailbox.personalUserId) throw badRequest("This mailbox is already personal");
    const [person] = await db
      .select({ userId: members.userId })
      .from(members)
      .where(and(eq(members.workspaceId, ctx.workspace.id), eq(members.userId, input.userId)));
    if (!person) throw notFound("Member");
    await db.transaction(async (tx) => {
      await tx.update(mailboxes).set({ personalUserId: person.userId }).where(eq(mailboxes.id, mailbox.id));
      await tx.delete(mailboxMembers).where(eq(mailboxMembers.mailboxId, mailbox.id));
      // Nobody else can be assigned its conversations any more.
      await tx
        .update(threads)
        .set({ assignedTo: null })
        .where(and(eq(threads.mailboxId, mailbox.id), sql`${threads.assignedTo} is distinct from ${person.userId}`));
    });
    await emit(ctx, "mailbox.made_personal", mailbox.address, { userId: person.userId });
    return { ok: true };
  });

export const setMemberMailboxes = adminAction("/members/set-mailboxes")
  .input(z.object({ userId: z.string(), mailboxIds: z.array(z.string()).max(500) }))
  .handler(async ({ input, ctx }) => {
    requireFeature(ctx, "team", "shared mailboxes", "Shared mailboxes need a paid plan");
    const db = getDb();
    const [target] = await db
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.workspaceId, ctx.workspace.id), eq(members.userId, input.userId)));
    if (!target) throw notFound("Member");
    // Personal mailboxes are never handed out, so they're left out on both sides.
    const owned = await db
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(and(eq(mailboxes.workspaceId, ctx.workspace.id), isNull(mailboxes.personalUserId)));
    const ownedIds = owned.map((row) => row.id);
    const valid = input.mailboxIds.filter((id) => ownedIds.includes(id));
    await db.transaction(async (tx) => {
      if (ownedIds.length) {
        await tx
          .delete(mailboxMembers)
          .where(and(eq(mailboxMembers.userId, input.userId), inArray(mailboxMembers.mailboxId, ownedIds)));
      }
      if (valid.length) {
        await tx.insert(mailboxMembers).values(valid.map((mailboxId) => ({ mailboxId, userId: input.userId })));
      }
    });
    await emit(ctx, "member.mailboxes_updated", input.userId);
    return { ok: true };
  });

export const disconnectConnection = adminAction("/connections/disconnect")
  .input(z.object({ id: z.string() }))
  .handler(async ({ input, ctx }) => {
    const db = getDb();
    const [connection] = await db
      .select()
      .from(connections)
      .where(and(eq(connections.id, input.id), eq(connections.workspaceId, ctx.workspace.id)));
    if (!connection) throw notFound("Connection");
    // The webhook goes first because it needs a working token. Then the grant is revoked.
    await tearDownConnection(connection);
    if (connection.provider === "resend" && connection.refreshTokenEnc) {
      await revokeGrant(decrypt(connection.refreshTokenEnc)).catch(() => undefined);
    }
    await db
      .update(connections)
      .set({ status: "disconnected", webhookId: null, webhookSecretEnc: null })
      .where(eq(connections.id, connection.id));
    await emit(ctx, "connection.disconnected", connection.id);
    return { ok: true };
  });

export const listMembers = workspaceAction("/members/list").handler(async ({ ctx }) => {
  const db = getDb();
  const [people, invites] = await Promise.all([
    db
      .select({ userId: members.userId, role: members.role, name: user.name, email: user.email, image: user.image })
      .from(members)
      .innerJoin(user, eq(user.id, members.userId))
      .where(eq(members.workspaceId, ctx.workspace.id)),
    db
      .select({ id: invitations.id, email: invitations.email, role: invitations.role, expiresAt: invitations.expiresAt })
      .from(invitations)
      .where(
        and(
          eq(invitations.workspaceId, ctx.workspace.id),
          isNull(invitations.acceptedAt),
          gt(invitations.expiresAt, new Date()),
        ),
      ),
  ]);
  const [assigned, personal] = people.length
    ? await Promise.all([
        db
          .select({ userId: mailboxMembers.userId, mailboxId: mailboxMembers.mailboxId })
          .from(mailboxMembers)
          .innerJoin(mailboxes, eq(mailboxes.id, mailboxMembers.mailboxId))
          .where(and(eq(mailboxes.workspaceId, ctx.workspace.id), isNull(mailboxes.personalUserId))),
        db
          .select({ userId: mailboxes.personalUserId, mailboxId: mailboxes.id })
          .from(mailboxes)
          .where(and(eq(mailboxes.workspaceId, ctx.workspace.id), isNotNull(mailboxes.personalUserId))),
      ])
    : [[], []];
  const access = [...assigned, ...personal];
  return {
    members: people.map((person) => ({
      ...person,
      mailboxIds: access.filter((row) => row.userId === person.userId).map((row) => row.mailboxId),
    })),
    invitations: invites,
  };
});

// Admins are a Business feature, and only the owner hands that role out.
function assertCanGrantRole(ctx: WorkspaceContext, role: "admin" | "member") {
  if (role !== "admin") return;
  if (ctx.role !== "owner") throw forbidden("Only the owner can add admins");
  requireFeature(ctx, "roles", "roles", "Admins need the Business plan");
}

export const inviteMember = adminAction("/members/invite")
  .input(z.object({ email: z.email(), role: z.enum(["admin", "member"]).default("member") }))
  .handler(async ({ input, ctx }) => {
    assertCanGrantRole(ctx, input.role);
    const db = getDb();
    const email = input.email.toLowerCase();
    const [memberCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(members)
      .where(eq(members.workspaceId, ctx.workspace.id));
    const [inviteCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(invitations)
      .where(
        and(
          eq(invitations.workspaceId, ctx.workspace.id),
          isNull(invitations.acceptedAt),
          gt(invitations.expiresAt, new Date()),
        ),
      );
    requireFeature(ctx, "team", "teammates", "Inviting teammates needs a paid plan");
    requireRoom(
      ctx,
      "members",
      (memberCount?.count ?? 0) + (inviteCount?.count ?? 0),
      "You've reached your plan's member limit",
    );
    const token = randomBytes(32).toString("base64url");
    await db.insert(invitations).values({
      workspaceId: ctx.workspace.id,
      email,
      role: input.role,
      tokenHash: hashToken(token),
      invitedBy: ctx.user.id,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    await sendAppEmail({
      to: email,
      subject: `${ctx.user.name} invited you to ${ctx.workspace.name} on HelloBox`,
      react: createElement(WorkspaceInvite, {
        inviter: ctx.user.name,
        workspace: ctx.workspace.name,
        url: `${getEnv().APP_URL}/invite?token=${token}`,
      }),
    });
    await emit(ctx, "member.invited", email);
    return { ok: true };
  });

export const revokeInvite = adminAction("/members/revoke-invite")
  .input(z.object({ id: z.string() }))
  .handler(async ({ input, ctx }) => {
    await getDb()
      .delete(invitations)
      .where(and(eq(invitations.id, input.id), eq(invitations.workspaceId, ctx.workspace.id)));
    return { ok: true };
  });

export const acceptInvite = userAction("/members/accept-invite")
  .input(z.object({ token: z.string().min(1) }))
  .handler(async ({ input, ctx }) => {
    const db = getDb();
    const [invite] = await db
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.tokenHash, hashToken(input.token)),
          isNull(invitations.acceptedAt),
          gt(invitations.expiresAt, new Date()),
        ),
      );
    if (!invite) throw notFound("Invitation");
    if (invite.email !== ctx.user.email.toLowerCase()) {
      throw forbidden(`This invitation was sent to ${invite.email}`);
    }
    // The plan may have shrunk, or other invites filled it, since this one was sent.
    const [workspace] = await db
      .select({ memberCount: sql<number>`(select count(*)::int from ${members} where ${members.workspaceId} = ${workspaces.id})` })
      .from(workspaces)
      .where(eq(workspaces.id, invite.workspaceId));
    const [alreadyMember] = await db
      .select({ userId: members.userId })
      .from(members)
      .where(and(eq(members.workspaceId, invite.workspaceId), eq(members.userId, ctx.user.id)));
    if (workspace && !alreadyMember && workspace.memberCount >= (await entitlements(invite.workspaceId)).limits.members) {
      throw fullWorkspaceError("This workspace is full. Ask its admin to upgrade the plan");
    }
    await db.transaction(async (tx) => {
      await tx
        .insert(members)
        .values({ workspaceId: invite.workspaceId, userId: ctx.user.id, role: invite.role })
        .onConflictDoNothing();
      await tx.update(invitations).set({ acceptedAt: new Date() }).where(eq(invitations.id, invite.id));
    });
    return { workspaceId: invite.workspaceId };
  });

export const updateMember = adminAction("/members/update")
  .input(z.object({ userId: z.string(), role: z.enum(["admin", "member"]).nullable() }))
  .handler(async ({ input, ctx }) => {
    const db = getDb();
    const [target] = await db
      .select()
      .from(members)
      .where(and(eq(members.workspaceId, ctx.workspace.id), eq(members.userId, input.userId)));
    if (!target) throw notFound("Member");
    if (target.role === "owner") throw forbidden("The owner can't be changed");
    if (target.role === "admin" && ctx.role !== "owner") throw forbidden("Only the owner can change admins");
    if (input.role) assertCanGrantRole(ctx, input.role);
    if (input.role) {
      await db.update(members).set({ role: input.role }).where(eq(members.id, target.id));
    } else {
      await clearMemberAccess(ctx.workspace.id, input.userId);
      await db.delete(members).where(eq(members.id, target.id));
    }
    await emit(ctx, input.role ? "member.role_changed" : "member.removed", input.userId, {
      role: input.role,
    });
    return { ok: true };
  });

const ruleInput = z.object({
  name: z.string().trim().min(1).max(100),
  conditions: z
    .array(
      z.object({
        field: z.enum(["from", "fromDomain", "to", "subject"]),
        op: z.enum(["equals", "contains"]),
        value: z.string().trim().min(1).max(200),
      }),
    )
    .min(1)
    .max(10),
  action: z.object({
    category: z.enum(["primary", "notifications", "purchases", "newsletters"]).optional(),
    labelId: z.string().optional(),
    folder: z.enum(["inbox", "archive", "spam", "trash"]).optional(),
  }),
});

export const listRules = workspaceAction("/rules/list").handler(async ({ ctx }) => {
  const db = getDb();
  const [ruleRows, senders] = await Promise.all([
    db.select().from(rules).where(eq(rules.workspaceId, ctx.workspace.id)).orderBy(rules.priority),
    db.select().from(senderLists).where(eq(senderLists.workspaceId, ctx.workspace.id)),
  ]);
  return { rules: ruleRows, senders };
});

export const createRule = adminAction("/rules/create")
  .input(ruleInput)
  .handler(async ({ input, ctx }) => {
    const [rule] = await getDb()
      .insert(rules)
      .values({ ...input, workspaceId: ctx.workspace.id })
      .returning();
    return rule;
  });

export const deleteRule = adminAction("/rules/delete")
  .input(z.object({ id: z.string() }))
  .handler(async ({ input, ctx }) => {
    await getDb().delete(rules).where(and(eq(rules.id, input.id), eq(rules.workspaceId, ctx.workspace.id)));
    return { ok: true };
  });

// Blocks an address or a whole domain. Mail receiving through HelloBox is refused outright
// (the sender gets a bounce); through a provider it goes to Spam. Blocking a personal mail
// provider's domain needs a second, explicit yes, since it also blocks everyone else there.
export const blockSenderValue = adminAction("/senders/block")
  .input(z.object({ value: z.string().max(320), confirmCommon: z.boolean().optional() }))
  .handler(async ({ input, ctx }) => {
    const target = parseBlockTarget(input.value);
    if (!target) throw badRequest("Enter an address like spam@example.com or a domain like example.com");
    if (target.kind === "domain" && isCommonMailDomain(target.value) && !input.confirmCommon) {
      return { blocked: false as const, needsConfirmation: true as const, value: target.value };
    }
    const db = getDb();
    await db
      .delete(senderLists)
      .where(and(eq(senderLists.workspaceId, ctx.workspace.id), eq(senderLists.kind, "allowed"), eq(senderLists.value, target.value)));
    await db
      .insert(senderLists)
      .values({ workspaceId: ctx.workspace.id, kind: "blocked", value: target.value })
      .onConflictDoNothing();
    return { blocked: true as const, needsConfirmation: false as const, value: target.value };
  });

export const removeSender = adminAction("/senders/remove")
  .input(z.object({ id: z.string() }))
  .handler(async ({ input, ctx }) => {
    await getDb()
      .delete(senderLists)
      .where(and(eq(senderLists.id, input.id), eq(senderLists.workspaceId, ctx.workspace.id)));
    return { ok: true };
  });

// Addresses mail isn't sent to after a permanent bounce or a spam report, with why.
export const listSuppressedAddresses = workspaceAction("/suppressions/list").handler(async ({ ctx }) => ({
  suppressions: await listSuppressions(ctx.workspace.id),
}));

// Lets mail go to an address again. Logged, since it overrides an automatic decision.
export const removeSuppressedAddress = adminAction("/suppressions/remove")
  .input(z.object({ id: z.string() }))
  .handler(async ({ input, ctx }) => {
    const removed = await removeSuppression(ctx.workspace.id, input.id);
    if (!removed) throw notFound("Suppressed address");
    await emit(ctx, "suppression.removed", removed.email, { reason: removed.reason });
    return { ok: true };
  });

// Labels take a color and an icon from the app's own sets (components/mail/label-style.tsx).
const labelColor = z.enum(["gray", "red", "orange", "amber", "green", "teal", "blue", "indigo", "violet", "pink"]);
const labelIcon = z.string().regex(/^[a-z-]{1,32}$/);

export const createLabel = workspaceAction("/labels/create")
  .input(z.object({
    name: z.string().trim().min(1).max(50),
    // Older callers sent free-form colors; anything outside the set is dropped.
    color: z.string().max(20).optional().transform((value) => (labelColor.safeParse(value).success ? value : undefined)),
    icon: labelIcon.optional(),
  }))
  .handler(async ({ input, ctx }) => {
    const [label] = await getDb()
      .insert(labels)
      .values({ ...input, workspaceId: ctx.workspace.id })
      .onConflictDoNothing()
      .returning();
    if (!label) throw conflict("This label already exists");
    return label;
  });

export const updateLabel = workspaceAction("/labels/update")
  .input(z.object({
    id: z.string(),
    name: z.string().trim().min(1).max(50).optional(),
    color: labelColor.nullable().optional(),
    icon: labelIcon.nullable().optional(),
  }))
  .handler(async ({ input, ctx }) => {
    const { id, ...patch } = input;
    if (!Object.keys(patch).length) throw badRequest("Nothing to change");
    const db = getDb();
    if (patch.name) {
      const [taken] = await db
        .select({ id: labels.id })
        .from(labels)
        .where(and(eq(labels.workspaceId, ctx.workspace.id), eq(labels.name, patch.name)));
      if (taken && taken.id !== id) throw conflict("This label already exists");
    }
    const [label] = await db
      .update(labels)
      .set(patch)
      .where(and(eq(labels.id, id), eq(labels.workspaceId, ctx.workspace.id)))
      .returning();
    if (!label) throw notFound("Label");
    return label;
  });

export const deleteLabel = adminAction("/labels/delete")
  .input(z.object({ id: z.string() }))
  .handler(async ({ input, ctx }) => {
    await getDb().delete(labels).where(and(eq(labels.id, input.id), eq(labels.workspaceId, ctx.workspace.id)));
    return { ok: true };
  });

// Everything the user can read in the workspace, as JSON. Attachments are linked rather than embedded.
export const exportData = adminAction("/account/export").handler(async ({ ctx }) => {
  const db = getDb();
  const [threadRows, messageRows, labelRows, ruleRows, contactRows, templateRows, campaignRows] = await Promise.all([
    db.select().from(threads).where(eq(threads.workspaceId, ctx.workspace.id)),
    db
      .select({
        id: messages.id,
        threadId: messages.threadId,
        direction: messages.direction,
        from: messages.fromAddress,
        to: messages.toRecipients,
        cc: messages.ccRecipients,
        subject: messages.subject,
        text: messages.textBody,
        html: messages.htmlBody,
        // Ciphertext for encrypted mailboxes. Opens with the owner's key, never on the server.
        sealedBody: messages.sealedBody,
        sentAt: messages.sentAt,
      })
      .from(messages)
      .where(eq(messages.workspaceId, ctx.workspace.id)),
    db.select().from(labels).where(eq(labels.workspaceId, ctx.workspace.id)),
    db.select().from(rules).where(eq(rules.workspaceId, ctx.workspace.id)),
    db
      .select({
        email: contacts.email,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        fields: contacts.fields,
        unsubscribedAt: contacts.unsubscribedAt,
        createdAt: contacts.createdAt,
      })
      .from(contacts)
      .where(eq(contacts.workspaceId, ctx.workspace.id)),
    db
      .select({ name: emailTemplates.name, subject: emailTemplates.subject, html: emailTemplates.html, updatedAt: emailTemplates.updatedAt })
      .from(emailTemplates)
      .where(eq(emailTemplates.workspaceId, ctx.workspace.id)),
    db
      .select({
        name: campaigns.name,
        subject: campaigns.subject,
        html: campaigns.html,
        values: campaigns.values,
        status: campaigns.status,
        recipientCount: campaigns.recipientCount,
        suppressedCount: campaigns.suppressedCount,
        sentAt: campaigns.sentAt,
      })
      .from(campaigns)
      .where(eq(campaigns.workspaceId, ctx.workspace.id)),
  ]);
  await emit(ctx, "workspace.exported");
  return {
    exportedAt: new Date(),
    threads: threadRows,
    messages: messageRows,
    labels: labelRows,
    rules: ruleRows,
    contacts: contactRows,
    templates: templateRows,
    campaigns: campaignRows,
  };
});

export const workspaceActions = {
  "/account/export": exportData,
  "/app/bootstrap": bootstrap,
  "/domains/set-enabled": setDomainEnabled,
  "/domains/sync": resyncDomains,
  "/domains/remove": removeDomain,
  "/domains/restore": restoreRemovedDomain,
  "/mailboxes/create": createMailbox,
  "/mailboxes/update": updateMailbox,
  "/mailboxes/set-personal": setMailboxPersonal,
  "/mailboxes/delete": deleteMailbox,
  "/members/set-mailboxes": setMemberMailboxes,
  "/connections/disconnect": disconnectConnection,
  "/members/list": listMembers,
  "/members/invite": inviteMember,
  "/members/revoke-invite": revokeInvite,
  "/members/accept-invite": acceptInvite,
  "/members/update": updateMember,
  "/rules/list": listRules,
  "/rules/create": createRule,
  "/rules/delete": deleteRule,
  "/senders/remove": removeSender,
  "/senders/block": blockSenderValue,
  "/suppressions/list": listSuppressedAddresses,
  "/suppressions/remove": removeSuppressedAddress,
  "/labels/create": createLabel,
  "/labels/update": updateLabel,
  "/labels/delete": deleteLabel,
};
