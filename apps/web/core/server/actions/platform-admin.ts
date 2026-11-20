import { getExtensions } from "@/core/extensions";
import {
  adminActions,
  adminAuthCodes,
  adminSessions,
  agentTokens,
  campaigns,
  contacts,
  domains,
  getDb,
  mailboxes,
  members,
  messages,
  session,
  threads,
  user,
  workspaces,
} from "@hellobox/db";
import { and, count, desc, eq, gt, ilike, inArray, isNotNull, isNull, lte, or, type SQL, sql } from "drizzle-orm";
import { badRequest, forbidden, notFound, unauthorized } from "nezt";
import { headers } from "next/headers";
import { z } from "zod";
import { getAuth } from "@/core/auth";
import {
  ADMIN_SESSION_HOURS,
  AUTH_CODE_SECONDS,
  adminEmails,
  confirmationCode,
  FRESH_SIGN_IN_MINUTES,
  generateAdminToken,
  generateAuthCode,
  isAdminEmail,
  isPkceChallenge,
  loopbackCallback,
  pkceMatches,
  sha256,
} from "../admin/auth";
import type { PlatformAdminContext } from "../admin/middleware";
import { platformAdminAction, publicAction, userAction } from "../builder";

const PAGE_SIZE = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

// Raw SQL skips drizzle's date mapping, so these come back as ISO strings directly.
export const isoTime = (value: SQL) =>
  sql<string | null>`to_char(${value} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const escapeLike = (value: string) => `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

export const logAdminAction = (
  ctx: PlatformAdminContext,
  entry: { action: string; targetType: string; targetId: string; targetLabel?: string; reason?: string },
) =>
  getDb()
    .insert(adminActions)
    .values({ adminUserId: ctx.admin.userId, adminEmail: ctx.admin.email, ...entry });

// Signing in. The terminal opens /admin/cli in the browser, where a recently
// signed-in admin approves it. The code goes back to the terminal's loopback
// listener, and only the terminal holding the PKCE verifier can trade it.

async function browserSession() {
  const current = await getAuth().api.getSession({ headers: await headers() });
  if (!current) throw unauthorized("Please sign in");
  const allowed = current.user.emailVerified && isAdminEmail(current.user.email);
  const fresh = Date.now() - new Date(current.session.createdAt).getTime() < FRESH_SIGN_IN_MINUTES * 60_000;
  return { userId: current.user.id, email: current.user.email, allowed, fresh };
}

const challengeInput = z.string().refine(isPkceChallenge, "This sign-in link is broken. Start again from the terminal");

export const checkCliSignIn = userAction("/admin/cli/check")
  .input(z.object({ challenge: challengeInput }))
  .handler(async ({ input }) => {
    const { email, allowed, fresh } = await browserSession();
    return { email, allowed, fresh, confirmation: confirmationCode(input.challenge) };
  });

export const approveCliSignIn = userAction("/admin/cli/approve")
  .input(
    z.object({
      challenge: challengeInput,
      state: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
      port: z.number().int().min(1024).max(65_535),
    }),
  )
  .handler(async ({ input }) => {
    const { userId, allowed, fresh } = await browserSession();
    if (!allowed) throw forbidden("This account can't use the admin tool");
    if (!fresh) throw forbidden(`Sign in again first. Approving needs a sign-in from the last ${FRESH_SIGN_IN_MINUTES} minutes`);
    const { code, hash } = generateAuthCode();
    await getDb()
      .insert(adminAuthCodes)
      .values({
        userId,
        codeHash: hash,
        challenge: input.challenge,
        expiresAt: new Date(Date.now() + AUTH_CODE_SECONDS * 1000),
      });
    return { redirect: loopbackCallback(input.port, code, input.state) };
  });

export const exchangeAdminCode = publicAction("/admin/auth/token")
  .input(z.object({ code: z.string().min(20).max(100), verifier: z.string().max(128) }))
  .handler(async ({ input }) => {
    const refused = () => unauthorized("This sign-in has expired. Start again with hellobox-admin login");
    if (!adminEmails().size) throw notFound("Action");
    const db = getDb();
    // Claimed in one statement, so a code works once even if it's sent twice at once.
    const [claimed] = await db
      .update(adminAuthCodes)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(adminAuthCodes.codeHash, sha256(input.code)),
          isNull(adminAuthCodes.usedAt),
          gt(adminAuthCodes.expiresAt, new Date()),
        ),
      )
      .returning();
    if (!claimed || !pkceMatches(input.verifier, claimed.challenge)) throw refused();
    const [person] = await db.select().from(user).where(eq(user.id, claimed.userId));
    if (!person || !person.emailVerified || person.bannedAt || !isAdminEmail(person.email)) throw refused();
    const { token, hash } = generateAdminToken();
    const expiresAt = new Date(Date.now() + ADMIN_SESSION_HOURS * 60 * 60 * 1000);
    const [created] = await db
      .insert(adminSessions)
      .values({ userId: person.id, tokenHash: hash, expiresAt })
      .returning({ id: adminSessions.id });
    await db.insert(adminActions).values({
      adminUserId: person.id,
      adminEmail: person.email,
      action: "signed_in",
      targetType: "admin",
      targetId: created?.id ?? person.id,
    });
    return { token, email: person.email, expiresAt };
  });

const OPEN_SECTIONS = ["overview", "users", "workspaces", "activity"];

export const adminWhoami = platformAdminAction("/admin/auth/me").handler(async ({ ctx }) => {
  const [row] = await getDb()
    .select({ expiresAt: adminSessions.expiresAt })
    .from(adminSessions)
    .where(eq(adminSessions.id, ctx.admin.sessionId));
  // The screens this server has: the open ones, plus what a hosted build adds.
  return { email: ctx.admin.email, expiresAt: row?.expiresAt ?? null, sections: [...OPEN_SECTIONS, ...(getExtensions().admin?.sections ?? [])] };
});

export const adminSignOut = platformAdminAction("/admin/auth/logout").handler(async ({ ctx }) => {
  await getDb()
    .update(adminSessions)
    .set({ revokedAt: new Date() })
    .where(eq(adminSessions.id, ctx.admin.sessionId));
  return { ok: true };
});

// Usage.

export const platformStats = platformAdminAction("/admin/stats").handler(async () => {
  const db = getDb();
  const since7 = new Date(Date.now() - 7 * DAY_MS);
  const since30 = new Date(Date.now() - 30 * DAY_MS);
  const [[users], [active], [spaces], [mail], [growth], signups, [extras], cloudStats] = await Promise.all([
    db
      .select({
        total: count(),
        verified: sql<number>`count(*) filter (where ${user.emailVerified})::int`,
        twoFactor: sql<number>`count(*) filter (where ${user.twoFactorEnabled})::int`,
        onboarded: sql<number>`count(*) filter (where ${user.onboardedAt} is not null)::int`,
        banned: sql<number>`count(*) filter (where ${user.bannedAt} is not null)::int`,
        new7d: sql<number>`count(*) filter (where ${gt(user.createdAt, since7)})::int`,
        new30d: sql<number>`count(*) filter (where ${gt(user.createdAt, since30)})::int`,
      })
      .from(user)
      // Demo visitors aren't people who signed up.
      .where(eq(user.isAnonymous, false)),
    db
      .select({
        active7d: sql<number>`count(distinct ${session.userId}) filter (where ${gt(session.updatedAt, since7)})::int`,
        active30d: sql<number>`count(distinct ${session.userId}) filter (where ${gt(session.updatedAt, since30)})::int`,
      })
      .from(session),
    db
      .select({
        total: count(),
        suspended: sql<number>`count(*) filter (where ${workspaces.suspendedAt} is not null)::int`,
        new30d: sql<number>`count(*) filter (where ${gt(workspaces.createdAt, since30)})::int`,
        storageBytes: sql<number>`coalesce(sum(${workspaces.storageBytesUsed}), 0)::float8`,
        connected: sql<number>`count(*) filter (where exists (select 1 from connections rc where rc.workspace_id = workspaces.id and rc.status = 'active'))::int`,
        members: sql<number>`(select count(*) from ${members})::int`,
      })
      .from(workspaces)
      .where(isNull(workspaces.demoExpiresAt)),
    db
      .select({
        total: count(),
        inbound30d: sql<number>`count(*) filter (where ${messages.direction} = 'inbound' and ${gt(messages.sentAt, since30)})::int`,
        outbound30d: sql<number>`count(*) filter (where ${messages.direction} = 'outbound' and ${gt(messages.sentAt, since30)})::int`,
        byAgents30d: sql<number>`count(*) filter (where ${messages.agentTokenId} is not null and ${gt(messages.sentAt, since30)})::int`,
      })
      .from(messages),
    db
      .select({
        threads: sql<number>`(select count(*) from ${threads})::int`,
        mailboxes: sql<number>`(select count(*) from ${mailboxes} where ${mailboxes.removedAt} is null)::int`,
        domains: sql<number>`(select count(*) from ${domains} where ${domains.enabled})::int`,
        contacts: sql<number>`(select count(*) from ${contacts})::int`,
      })
      .from(sql`(select 1) as one`),
    db.execute<{ day: string; users: number; workspaces: number }>(sql`
      select to_char(day, 'YYYY-MM-DD') as day,
        (select count(*) from ${user} where ${user.createdAt} >= day and ${user.createdAt} < day + interval '1 day')::int as users,
        (select count(*) from ${workspaces} where ${workspaces.createdAt} >= day and ${workspaces.createdAt} < day + interval '1 day')::int as workspaces
      from generate_series(date_trunc('day', now()) - interval '29 days', date_trunc('day', now()), interval '1 day') as day
      order by day`),
    db
      .select({
        campaignsSent: sql<number>`(select count(*) from ${campaigns} where ${campaigns.status} = 'sent')::int`,
        campaignRecipients: sql<number>`(select coalesce(sum(${campaigns.recipientCount}), 0) from ${campaigns} where ${campaigns.status} = 'sent')::int`,
        agentConnections: sql<number>`(select count(*) from ${agentTokens} where ${agentTokens.revokedAt} is null and ${agentTokens.expiresAt} > now())::int`,
      })
      .from(sql`(select 1) as one`),
    getExtensions().admin?.stats?.() ?? {},
  ]);

  return {
    users: { ...users!, ...active! },
    workspaces: {
      total: spaces!.total,
      suspended: spaces!.suspended,
      new30d: spaces!.new30d,
      connectedToResend: spaces!.connected,
      members: spaces!.members,
      ...cloudStats,
    },
    mail: {
      messages: mail!.total,
      inbound30d: mail!.inbound30d,
      outbound30d: mail!.outbound30d,
      threads: growth!.threads,
      mailboxes: growth!.mailboxes,
      domains: growth!.domains,
      contacts: growth!.contacts,
      storageBytes: spaces!.storageBytes,
    },
    campaigns: { sent: extras!.campaignsSent, recipients: extras!.campaignRecipients },
    agents: { activeConnections: extras!.agentConnections, messagesSent30d: mail!.byAgents30d },
    signups: [...signups].map((row) => ({ day: row.day, users: Number(row.users), workspaces: Number(row.workspaces) })),
    generatedAt: new Date(),
  };
});

// Users.

const pageInput = z.object({
  query: z.string().trim().max(200).default(""),
  page: z.number().int().min(0).max(100_000).default(0),
});

export const listPlatformUsers = platformAdminAction("/admin/users/list")
  .input(pageInput.extend({ filter: z.enum(["all", "banned", "unverified"]).default("all") }))
  .handler(async ({ input }) => {
    const db = getDb();
    const filters: (SQL | undefined)[] = [
      input.query ? or(ilike(user.email, escapeLike(input.query)), ilike(user.name, escapeLike(input.query))) : undefined,
      input.filter === "banned" ? isNotNull(user.bannedAt) : undefined,
      input.filter === "unverified" ? eq(user.emailVerified, false) : undefined,
      eq(user.isAnonymous, false),
    ];
    const where = and(...filters);
    const [rows, [matching]] = await Promise.all([
      db
        .select({
          id: user.id,
          name: user.name,
          email: user.email,
          emailVerified: user.emailVerified,
          twoFactorEnabled: user.twoFactorEnabled,
          bannedAt: user.bannedAt,
          banReason: user.banReason,
          createdAt: user.createdAt,
          workspaces: sql<number>`(select count(*) from members m where m.user_id = "user".id)::int`,
          lastActiveAt: isoTime(sql`(select max(s.updated_at) from session s where s.user_id = "user".id)`),
        })
        .from(user)
        .where(where)
        .orderBy(desc(user.createdAt), user.id)
        .limit(PAGE_SIZE)
        .offset(input.page * PAGE_SIZE),
      db.select({ count: count() }).from(user).where(where),
    ]);
    const allowlist = adminEmails();
    return {
      users: rows.map((row) => ({ ...row, isAdmin: isAdminEmail(row.email, allowlist) })),
      matching: matching?.count ?? 0,
      pageSize: PAGE_SIZE,
    };
  });

export const getPlatformUser = platformAdminAction("/admin/users/get")
  .input(z.object({ id: z.string() }))
  .handler(async ({ input }) => {
    const db = getDb();
    const [person] = await db
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
        emailVerified: user.emailVerified,
        twoFactorEnabled: user.twoFactorEnabled,
        onboardedAt: user.onboardedAt,
        bannedAt: user.bannedAt,
        banReason: user.banReason,
        createdAt: user.createdAt,
      })
      .from(user)
      .where(eq(user.id, input.id));
    if (!person) throw notFound("User");
    const [memberships, [sessions], [agents]] = await Promise.all([
      db
        .select({
          id: workspaces.id,
          name: workspaces.name,
          role: members.role,
          suspendedAt: workspaces.suspendedAt,
        })
        .from(members)
        .innerJoin(workspaces, eq(workspaces.id, members.workspaceId))
        .where(eq(members.userId, input.id))
        .orderBy(members.createdAt),
      db
        .select({ active: count(), lastActiveAt: isoTime(sql`max(${session.updatedAt})`) })
        .from(session)
        .where(and(eq(session.userId, input.id), gt(session.expiresAt, new Date()))),
      db
        .select({ active: count() })
        .from(agentTokens)
        .where(and(eq(agentTokens.userId, input.id), isNull(agentTokens.revokedAt), gt(agentTokens.expiresAt, new Date()))),
    ]);
    return {
      ...person,
      isAdmin: isAdminEmail(person.email),
      workspaces: await withWorkspaceFields(memberships),
      activeSessions: sessions?.active ?? 0,
      lastActiveAt: sessions?.lastActiveAt ?? null,
      agentConnections: agents?.active ?? 0,
    };
  });

// Ends every way the user is signed in: browser sessions, agent connections and
// admin sessions.
async function signOutEverywhere(userId: string) {
  const db = getDb();
  const auth = await getAuth().$context;
  await auth.internalAdapter.deleteUserSessions(userId);
  const now = new Date();
  await Promise.all([
    db.update(agentTokens).set({ revokedAt: now }).where(and(eq(agentTokens.userId, userId), isNull(agentTokens.revokedAt))),
    db.update(adminSessions).set({ revokedAt: now }).where(and(eq(adminSessions.userId, userId), isNull(adminSessions.revokedAt))),
  ]);
}

const reasonInput = z.string().trim().min(3, "Give a reason").max(500);

async function findUser(id: string) {
  const [person] = await getDb().select({ id: user.id, email: user.email }).from(user).where(eq(user.id, id));
  if (!person) throw notFound("User");
  return person;
}

export const banPlatformUser = platformAdminAction("/admin/users/ban")
  .input(z.object({ id: z.string(), reason: reasonInput }))
  .handler(async ({ input, ctx }) => {
    const person = await findUser(input.id);
    if (person.id === ctx.admin.userId) throw badRequest("You can't ban yourself");
    if (isAdminEmail(person.email)) throw badRequest("Remove them from ADMIN_EMAILS before banning an admin");
    await getDb().update(user).set({ bannedAt: new Date(), banReason: input.reason }).where(eq(user.id, person.id));
    await signOutEverywhere(person.id);
    await logAdminAction(ctx, { action: "user.banned", targetType: "user", targetId: person.id, targetLabel: person.email, reason: input.reason });
    return { ok: true };
  });

export const unbanPlatformUser = platformAdminAction("/admin/users/unban")
  .input(z.object({ id: z.string() }))
  .handler(async ({ input, ctx }) => {
    const person = await findUser(input.id);
    await getDb().update(user).set({ bannedAt: null, banReason: null }).where(eq(user.id, person.id));
    await logAdminAction(ctx, { action: "user.unbanned", targetType: "user", targetId: person.id, targetLabel: person.email });
    return { ok: true };
  });

export const signOutPlatformUser = platformAdminAction("/admin/users/sign-out")
  .input(z.object({ id: z.string() }))
  .handler(async ({ input, ctx }) => {
    const person = await findUser(input.id);
    if (person.id === ctx.admin.userId) throw badRequest("Use hellobox-admin logout to sign yourself out");
    await signOutEverywhere(person.id);
    await logAdminAction(ctx, { action: "user.signed_out", targetType: "user", targetId: person.id, targetLabel: person.email });
    return { ok: true };
  });

// Workspaces.

// Correlated subqueries name their tables, since drizzle leaves columns unqualified
// and they'd bind to the inner table.
const ownerEmail = sql<string | null>`(select u.email from members m join "user" u on u.id = m.user_id where m.workspace_id = workspaces.id and m.role = 'owner' limit 1)`;

// Adds what a hosted build knows about each workspace (plan, subscription), if anything.
async function withWorkspaceFields<T extends { id: string }>(rows: T[]) {
  const fields = await getExtensions().admin?.workspaceFields?.(rows.map((row) => row.id));
  return fields ? rows.map((row) => ({ ...row, ...fields[row.id] })) : rows;
}

export const listPlatformWorkspaces = platformAdminAction("/admin/workspaces/list")
  .input(pageInput.extend({ filter: z.string().max(40).default("all") }))
  .handler(async ({ input }) => {
    const db = getDb();
    // "all", "suspended", and whatever a hosted build adds ("paying").
    const extra = input.filter === "all" || input.filter === "suspended" ? undefined : getExtensions().admin?.workspaceFilters?.[input.filter];
    if (input.filter !== "all" && input.filter !== "suspended" && !extra) throw badRequest("Unknown filter");
    const filters: (SQL | undefined)[] = [
      input.query ? or(ilike(workspaces.name, escapeLike(input.query)), sql`${ownerEmail} ilike ${escapeLike(input.query)}`) : undefined,
      isNull(workspaces.demoExpiresAt),
      extra,
      input.filter === "suspended" ? isNotNull(workspaces.suspendedAt) : undefined,
    ];
    const where = and(...filters);
    const [rows, [matching]] = await Promise.all([
      db
        .select({
          id: workspaces.id,
          name: workspaces.name,
          storageBytesUsed: workspaces.storageBytesUsed,
          suspendedAt: workspaces.suspendedAt,
          suspendReason: workspaces.suspendReason,
          createdAt: workspaces.createdAt,
          owner: ownerEmail,
          members: sql<number>`(select count(*) from members m where m.workspace_id = workspaces.id)::int`,
          mailboxes: sql<number>`(select count(*) from mailboxes mb where mb.workspace_id = workspaces.id and mb.removed_at is null)::int`,
        })
        .from(workspaces)
        .where(where)
        .orderBy(desc(workspaces.createdAt), workspaces.id)
        .limit(PAGE_SIZE)
        .offset(input.page * PAGE_SIZE),
      db.select({ count: count() }).from(workspaces).where(where),
    ]);
    return { workspaces: await withWorkspaceFields(rows), matching: matching?.count ?? 0, pageSize: PAGE_SIZE };
  });

export const getPlatformWorkspace = platformAdminAction("/admin/workspaces/get")
  .input(z.object({ id: z.string() }))
  .handler(async ({ input }) => {
    const db = getDb();
    const [workspace] = await db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        storageBytesUsed: workspaces.storageBytesUsed,
        suspendedAt: workspaces.suspendedAt,
        suspendReason: workspaces.suspendReason,
        createdAt: workspaces.createdAt,
      })
      .from(workspaces)
      .where(eq(workspaces.id, input.id));
    if (!workspace) throw notFound("Workspace");
    const since30 = new Date(Date.now() - 30 * DAY_MS);
    const [people, domainRows, [usage]] = await Promise.all([
      db
        .select({ id: user.id, name: user.name, email: user.email, role: members.role, bannedAt: user.bannedAt })
        .from(members)
        .innerJoin(user, eq(user.id, members.userId))
        .where(eq(members.workspaceId, input.id))
        .orderBy(members.createdAt),
      db
        .select({ name: domains.name, enabled: domains.enabled, sendingEnabled: domains.sendingEnabled })
        .from(domains)
        .where(eq(domains.workspaceId, input.id))
        .orderBy(domains.name),
      db
        .select({
          threads: sql<number>`(select count(*) from ${threads} where ${threads.workspaceId} = ${input.id})::int`,
          messages30d: sql<number>`(select count(*) from ${messages} where ${messages.workspaceId} = ${input.id} and ${gt(messages.sentAt, since30)})::int`,
          contacts: sql<number>`(select count(*) from ${contacts} where ${contacts.workspaceId} = ${input.id})::int`,
          campaignsSent: sql<number>`(select count(*) from ${campaigns} where ${campaigns.workspaceId} = ${input.id} and ${campaigns.status} = 'sent')::int`,
        })
        .from(sql`(select 1) as one`),
    ]);
    return { ...(await withWorkspaceFields([workspace]))[0]!, members: people, domains: domainRows, usage: usage! };
  });

async function findWorkspace(id: string) {
  const [workspace] = await getDb()
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, id));
  if (!workspace) throw notFound("Workspace");
  return workspace;
}

export const suspendPlatformWorkspace = platformAdminAction("/admin/workspaces/suspend")
  .input(z.object({ id: z.string(), reason: reasonInput }))
  .handler(async ({ input, ctx }) => {
    const workspace = await findWorkspace(input.id);
    await getDb()
      .update(workspaces)
      .set({ suspendedAt: new Date(), suspendReason: input.reason })
      .where(eq(workspaces.id, workspace.id));
    await logAdminAction(ctx, {
      action: "workspace.suspended",
      targetType: "workspace",
      targetId: workspace.id,
      targetLabel: workspace.name,
      reason: input.reason,
    });
    return { ok: true };
  });

export const unsuspendPlatformWorkspace = platformAdminAction("/admin/workspaces/unsuspend")
  .input(z.object({ id: z.string() }))
  .handler(async ({ input, ctx }) => {
    const workspace = await findWorkspace(input.id);
    await getDb()
      .update(workspaces)
      .set({ suspendedAt: null, suspendReason: null })
      .where(eq(workspaces.id, workspace.id));
    await logAdminAction(ctx, {
      action: "workspace.unsuspended",
      targetType: "workspace",
      targetId: workspace.id,
      targetLabel: workspace.name,
    });
    return { ok: true };
  });

export const listAdminActivity = platformAdminAction("/admin/activity").handler(async () =>
  getDb().select().from(adminActions).orderBy(desc(adminActions.createdAt)).limit(200),
);

export const platformAdminActions = {
  "/admin/cli/check": checkCliSignIn,
  "/admin/cli/approve": approveCliSignIn,
  "/admin/auth/token": exchangeAdminCode,
  "/admin/auth/me": adminWhoami,
  "/admin/auth/logout": adminSignOut,
  "/admin/stats": platformStats,
  "/admin/users/list": listPlatformUsers,
  "/admin/users/get": getPlatformUser,
  "/admin/users/ban": banPlatformUser,
  "/admin/users/unban": unbanPlatformUser,
  "/admin/users/sign-out": signOutPlatformUser,
  "/admin/workspaces/list": listPlatformWorkspaces,
  "/admin/workspaces/get": getPlatformWorkspace,
  "/admin/workspaces/suspend": suspendPlatformWorkspace,
  "/admin/workspaces/unsuspend": unsuspendPlatformWorkspace,
  "/admin/activity": listAdminActivity,
};
