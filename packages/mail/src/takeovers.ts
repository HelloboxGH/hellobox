import { randomBytes } from "node:crypto";
import { Resolver } from "node:dns/promises";
import {
  connections,
  domainAccessRequests,
  domains,
  domainTakeovers,
  getDb,
  members,
  user,
  workspaces,
} from "@hellobox/db";
import { emitEvent, getExtensions, type WorkspaceEventName } from "@hellobox/extensions";
import { DomainClaim, type DomainClaimEmail, domainClaimSubject, sendAppEmail } from "@hellobox/email";
import { and, eq, gt, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { createElement } from "react";
import { fitsPlan } from "./domain-names";
import { claimConflict, countedDomainNames, domainClaims, domainKey, lockDomainName } from "./domains";
import { setMailgunReceiving } from "./mailgun";
import { setPostmarkReceiving } from "./postmark";
import { domainLimitFor, setSesReceiving } from "./ses";

// Claiming a domain another workspace has on. All of these have to hold:
// - the claimer's own provider has verified the domain;
// - a TXT record we look up ourselves proves they control its DNS right now;
// - nobody has used the holder's workspace for QUIET_DAYS (see touchWorkspace);
// - the holder's admins had NOTICE_DAYS' notice, and nobody used the workspace or kept
//   the domain in that time.
// A workspace whose verified SSO domain it is never loses it, and one claiming its own
// verified SSO domain doesn't wait for the holder to go quiet.
export const QUIET_DAYS = 90;
export const NOTICE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
// Asking for access emails strangers, so it's kept rare.
const ACCESS_REQUEST_EVERY_MS = 7 * DAY_MS;
const ACCESS_REQUESTS_PER_DAY = 10;

export class DomainClaimError extends Error {}

export const txtRecordFor = (domain: string, token: string) => ({
  type: "TXT" as const,
  name: `_hellobox.${domainKey(domain)}`,
  value: `hellobox-verify=${token}`,
});

export type TakeoverCheck =
  | { state: "dns"; record: ReturnType<typeof txtRecordFor> }
  | { state: "free" }
  | { state: "holder-active" }
  | { state: "holder-sso" }
  | { state: "notice"; noticeEndsAt: Date };

// Whether the holder has been quiet long enough to lose the domain. A workspace that has
// never been used counts from when it was made.
export function isQuiet(holder: { lastActiveAt: Date | null; createdAt: Date }, now: Date, days = QUIET_DAYS) {
  return (holder.lastActiveAt ?? holder.createdAt).getTime() <= now.getTime() - days * DAY_MS;
}

// Public resolvers first, so a stale record cached near us can't decide it.
async function lookupTxt(name: string): Promise<string[]> {
  const resolvers = [["1.1.1.1", "8.8.8.8"], null] as const;
  for (const servers of resolvers) {
    const resolver = new Resolver({ timeout: 5000, tries: 2 });
    if (servers) resolver.setServers([...servers]);
    try {
      return (await resolver.resolveTxt(name)).map((chunks) => chunks.join(""));
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "ENOTFOUND" || code === "ENODATA") return [];
    }
  }
  return [];
}

// Swapped out in tests.
export const takeoverDeps = { lookupTxt };

export async function hasTxtProof(domain: string, token: string) {
  const record = txtRecordFor(domain, token);
  return (await takeoverDeps.lookupTxt(record.name)).some((value) => value.trim() === record.value);
}

async function adminEmails(workspaceId: string) {
  const rows = await getDb()
    .select({ email: user.email })
    .from(members)
    .innerJoin(user, eq(user.id, members.userId))
    .where(and(eq(members.workspaceId, workspaceId), inArray(members.role, ["owner", "admin"])));
  return rows.map((row) => row.email);
}

async function email(to: string[], content: DomainClaimEmail) {
  await Promise.all(
    to.map((address) =>
      sendAppEmail({ to: address, subject: domainClaimSubject(content), react: createElement(DomainClaim, content) }).catch(
        (error: unknown) => console.error("[domain-claim] Couldn't send an email:", error),
      ),
    ),
  );
}

async function requesterEmail(takeover: { requestedBy: string | null }) {
  if (!takeover.requestedBy) return [];
  const [row] = await getDb().select({ email: user.email }).from(user).where(eq(user.id, takeover.requestedBy));
  return row ? [row.email] : [];
}

const audit = (workspaceId: string, userId: string | null, name: WorkspaceEventName, target: string, metadata?: Record<string, unknown>) =>
  emitEvent({ name, workspaceId, userId, target, metadata });

// The claimer's own copy of the domain: in their workspace, still in HelloBox, and
// verified by their provider, which is the first proof asked of them.
async function requesterDomain(domainId: string, workspaceId: string) {
  const [row] = await getDb()
    .select({ id: domains.id, name: domains.name, status: domains.status, removedAt: domains.removedAt })
    .from(domains)
    .innerJoin(connections, eq(connections.id, domains.connectionId))
    .where(and(eq(domains.id, domainId), eq(domains.workspaceId, workspaceId), ne(connections.provider, "demo")));
  if (!row || row.removedAt) throw new DomainClaimError("Domain not found");
  if (row.status !== "verified") throw new DomainClaimError(`Verify ${row.name} with your provider first`);
  return row;
}

// Whether the workspace has set up single sign-on for this domain, which makes it theirs
// for good. SSO is cloud's, so with nothing registered the answer is no.
export async function hasVerifiedSso(workspaceId: string, name: string) {
  return (await getExtensions().auth?.ssoOwnsDomain?.(workspaceId, domainKey(name))) ?? false;
}

// Starts a claim, or picks up the open one, and returns the TXT record to add.
export async function startTakeover(input: { workspaceId: string; domainId: string; userId: string }) {
  const domain = await requesterDomain(input.domainId, input.workspaceId);
  const name = domainKey(domain.name);
  const db = getDb();
  const taken = claimConflict(await db.transaction((tx) => domainClaims(tx, name)), {
    domainId: domain.id,
    workspaceId: input.workspaceId,
  });
  if (taken === "this-workspace") throw new DomainClaimError(`${name} is already on through another provider in this workspace`);
  if (!taken) throw new DomainClaimError(`${name} isn't on anywhere else. Turn it on instead`);
  const open = await openTakeover(input.workspaceId, name);
  if (open) return { id: open.id, status: open.status, record: txtRecordFor(name, open.token), noticeEndsAt: open.noticeEndsAt };
  const token = randomBytes(18).toString("base64url");
  const [row] = await db
    .insert(domainTakeovers)
    .values({ domainName: name, requesterWorkspaceId: input.workspaceId, requesterDomainId: domain.id, requestedBy: input.userId, token })
    .onConflictDoNothing()
    .returning();
  const created = row ?? (await openTakeover(input.workspaceId, name));
  if (!created) throw new Error("Couldn't start the claim");
  await audit(input.workspaceId, input.userId, "domain.claim_started", name);
  return { id: created.id, status: created.status, record: txtRecordFor(name, created.token), noticeEndsAt: created.noticeEndsAt };
}

async function openTakeover(workspaceId: string, name: string) {
  const [row] = await getDb()
    .select()
    .from(domainTakeovers)
    .where(
      and(
        eq(domainTakeovers.requesterWorkspaceId, workspaceId),
        eq(domainTakeovers.domainName, name),
        inArray(domainTakeovers.status, ["dns", "notice"]),
      ),
    );
  return row ?? null;
}

async function cancel(id: string, reason: string) {
  await getDb()
    .update(domainTakeovers)
    .set({ status: "cancelled", cancelledAt: new Date(), cancelReason: reason })
    .where(and(eq(domainTakeovers.id, id), inArray(domainTakeovers.status, ["dns", "notice"])));
}

// "Check DNS": once the TXT record is there, decides whether the claim can go ahead and,
// if so, starts the holder's notice. Nothing about the holder is said before the record
// checks out, and even then only whether the claim can go ahead.
export async function checkTakeover(input: { workspaceId: string; takeoverId: string; now?: Date }): Promise<TakeoverCheck> {
  const now = input.now ?? new Date();
  const db = getDb();
  const [takeover] = await db
    .select()
    .from(domainTakeovers)
    .where(and(eq(domainTakeovers.id, input.takeoverId), eq(domainTakeovers.requesterWorkspaceId, input.workspaceId)));
  if (!takeover || (takeover.status !== "dns" && takeover.status !== "notice")) throw new DomainClaimError("This claim has ended");
  if (takeover.status === "notice") return { state: "notice", noticeEndsAt: takeover.noticeEndsAt! };
  await requesterDomain(takeover.requesterDomainId, input.workspaceId);
  const name = takeover.domainName;
  if (!(await hasTxtProof(name, takeover.token))) return { state: "dns", record: txtRecordFor(name, takeover.token) };

  const result = await db.transaction(async (tx) => {
    await lockDomainName(tx, name);
    const claims = (await domainClaims(tx, name)).filter((claim) => claim.workspaceId !== input.workspaceId);
    const holder = claims[0];
    if (!holder) return { state: "free" as const };
    if (await hasVerifiedSso(holder.workspaceId, name)) return { state: "holder-sso" as const };
    const [holderWorkspace] = await tx
      .select({ name: workspaces.name, lastActiveAt: workspaces.lastActiveAt, createdAt: workspaces.createdAt })
      .from(workspaces)
      .where(eq(workspaces.id, holder.workspaceId));
    if (!holderWorkspace) return { state: "free" as const };
    const ownSso = await hasVerifiedSso(input.workspaceId, name);
    if (!ownSso && !isQuiet(holderWorkspace, now)) return { state: "holder-active" as const };
    const noticeEndsAt = new Date(now.getTime() + NOTICE_DAYS * DAY_MS);
    await tx
      .update(domainTakeovers)
      .set({
        status: "notice",
        holderWorkspaceId: holder.workspaceId,
        holderDomainId: holder.domainId,
        dnsVerifiedAt: now,
        noticeEndsAt,
      })
      .where(eq(domainTakeovers.id, takeover.id));
    return { state: "notice" as const, noticeEndsAt, holder: { workspaceId: holder.workspaceId, name: holderWorkspace.name } };
  });

  if (result.state === "notice") {
    await email(await adminEmails(result.holder.workspaceId), {
      kind: "notice",
      domain: name,
      workspace: result.holder.name,
      endsAt: result.noticeEndsAt,
    });
    await audit(result.holder.workspaceId, null, "domain.claim_notice", name, { endsAt: result.noticeEndsAt });
    await audit(input.workspaceId, takeover.requestedBy, "domain.claim_dns_verified", name);
    return { state: "notice", noticeEndsAt: result.noticeEndsAt };
  }
  // Free now: they can simply turn it on. Blocked: the claim can't go ahead, so it ends.
  await cancel(takeover.id, result.state);
  return result;
}

// The claimer gives up.
export async function withdrawTakeover(input: { workspaceId: string; takeoverId: string; userId: string }) {
  const [row] = await getDb()
    .select({ domainName: domainTakeovers.domainName })
    .from(domainTakeovers)
    .where(and(eq(domainTakeovers.id, input.takeoverId), eq(domainTakeovers.requesterWorkspaceId, input.workspaceId)));
  if (!row) throw new DomainClaimError("Claim not found");
  await cancel(input.takeoverId, "withdrawn");
  await audit(input.workspaceId, input.userId, "domain.claim_withdrawn", row.domainName);
}

// An admin of the holder keeps the domain.
export async function keepDomain(input: { workspaceId: string; takeoverId: string; userId: string }) {
  const [takeover] = await getDb()
    .select()
    .from(domainTakeovers)
    .where(
      and(
        eq(domainTakeovers.id, input.takeoverId),
        eq(domainTakeovers.holderWorkspaceId, input.workspaceId),
        eq(domainTakeovers.status, "notice"),
      ),
    );
  if (!takeover) throw new DomainClaimError("Claim not found");
  await cancel(takeover.id, "kept");
  await audit(input.workspaceId, input.userId, "domain.claim_kept", takeover.domainName);
  await email(await requesterEmail(takeover), { kind: "stopped", domain: takeover.domainName, reason: "kept" });
}

// Claims against this workspace that are in their notice period, for its Settings.
export function incomingTakeovers(workspaceId: string) {
  return getDb()
    .select({ id: domainTakeovers.id, domain: domainTakeovers.domainName, noticeEndsAt: domainTakeovers.noticeEndsAt })
    .from(domainTakeovers)
    .where(and(eq(domainTakeovers.holderWorkspaceId, workspaceId), eq(domainTakeovers.status, "notice")));
}

// This workspace's own open claims, with the TXT record each needs.
export async function outgoingTakeovers(workspaceId: string) {
  const rows = await getDb()
    .select()
    .from(domainTakeovers)
    .where(and(eq(domainTakeovers.requesterWorkspaceId, workspaceId), inArray(domainTakeovers.status, ["dns", "notice"])));
  return rows.map((row) => ({
    id: row.id,
    domainId: row.requesterDomainId,
    domain: row.domainName,
    status: row.status as "dns" | "notice",
    noticeEndsAt: row.noticeEndsAt,
    record: txtRecordFor(row.domainName, row.token),
  }));
}

// Best effort: the holder's provider stops receiving the domain for them. Its connection
// may well be broken by now, and the new owner's MX decides where mail goes anyway.
async function stopHolderReceiving(domainId: string) {
  const db = getDb();
  const [row] = await db
    .select({ domain: domains, connection: connections })
    .from(domains)
    .innerJoin(connections, eq(connections.id, domains.connectionId))
    .where(eq(domains.id, domainId));
  if (!row || row.connection.status !== "active" || !row.domain.receivingEnabled) return;
  const { connectionId, workspaceId, name } = row.domain;
  try {
    if (row.connection.provider === "ses") {
      const receiving = await db
        .select({ name: domains.name })
        .from(domains)
        .where(and(eq(domains.connectionId, connectionId), eq(domains.receivingEnabled, true), isNull(domains.removedAt)));
      await setSesReceiving(connectionId, workspaceId, receiving.map((d) => d.name).filter((n) => n !== name));
    }
    if (row.connection.provider === "postmark") await setPostmarkReceiving(connectionId, workspaceId, null);
    if (row.connection.provider === "mailgun") await setMailgunReceiving(connectionId, workspaceId, name, false);
  } catch (error) {
    console.error(`[domain-claim] Couldn't turn off receiving for ${name}:`, error);
  }
}

// Run by maintenance: claims whose notice has ended either go through or stop.
export async function completeDueTakeovers(now = new Date()) {
  const due = await getDb()
    .select()
    .from(domainTakeovers)
    .where(and(eq(domainTakeovers.status, "notice"), lte(domainTakeovers.noticeEndsAt, now)));
  for (const takeover of due) {
    try {
      await completeTakeover(takeover, now);
    } catch (error) {
      console.error(`[domain-claim] Couldn't finish the claim on ${takeover.domainName}:`, error);
    }
  }
}

type Takeover = typeof domainTakeovers.$inferSelect;

async function stop(takeover: Takeover, reason: "active" | "dns" | "unverified") {
  await cancel(takeover.id, reason);
  await audit(takeover.requesterWorkspaceId, null, "domain.claim_stopped", takeover.domainName, { reason });
  await email(await requesterEmail(takeover), { kind: "stopped", domain: takeover.domainName, reason });
}

export async function completeTakeover(takeover: Takeover, now = new Date()) {
  const db = getDb();
  const name = takeover.domainName;
  // Any use of the holder's workspace since the notice went out stops the claim.
  if (takeover.holderWorkspaceId) {
    const [used] = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.id, takeover.holderWorkspaceId), gt(workspaces.lastActiveAt, takeover.dnsVerifiedAt!)));
    if (used) return stop(takeover, "active");
  }
  const [own] = await db
    .select({ status: domains.status, removedAt: domains.removedAt })
    .from(domains)
    .where(eq(domains.id, takeover.requesterDomainId));
  if (!own || own.removedAt || own.status !== "verified") return stop(takeover, "unverified");
  if (!(await hasTxtProof(name, takeover.token))) return stop(takeover, "dns");

  const fits = fitsPlan(
    await countedDomainNames(takeover.requesterWorkspaceId),
    name,
    await domainLimitFor(takeover.requesterWorkspaceId),
  );
  const moved = await db.transaction(async (tx) => {
    await lockDomainName(tx, name);
    // Every other place that has it on gives it up: normally only the holder.
    const losers = (await domainClaims(tx, name)).filter((claim) => claim.domainId !== takeover.requesterDomainId);
    if (losers.some((claim) => claim.workspaceId === takeover.requesterWorkspaceId)) return null;
    if (losers.length) {
      await tx
        .update(domains)
        .set({ removedAt: now, enabled: false, receivingEnabled: false })
        .where(inArray(domains.id, losers.map((claim) => claim.domainId)));
    }
    await tx.update(domains).set({ enabled: fits }).where(eq(domains.id, takeover.requesterDomainId));
    await tx
      .update(domainTakeovers)
      .set({ status: "completed", completedAt: now })
      .where(eq(domainTakeovers.id, takeover.id));
    return losers;
  });
  if (!moved) return stop(takeover, "unverified");

  for (const loser of moved) {
    await stopHolderReceiving(loser.domainId);
    const [holder] = await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, loser.workspaceId));
    await audit(loser.workspaceId, null, "domain.claimed_away", name, { takeoverId: takeover.id });
    await email(await adminEmails(loser.workspaceId), { kind: "taken", domain: name, workspace: holder?.name ?? "your workspace" });
  }
  await audit(takeover.requesterWorkspaceId, takeover.requestedBy, "domain.claimed", name, { enabled: fits });
  await email(await requesterEmail(takeover), { kind: "claimed", domain: name, enabled: fits });
}

// "Request access": emails the holder's admins who asked, without telling the asker who
// they are. Only for a domain the asker's own provider has verified.
export async function requestDomainAccess(input: { workspaceId: string; domainId: string; userId: string; now?: Date }) {
  const now = input.now ?? new Date();
  const domain = await requesterDomain(input.domainId, input.workspaceId);
  const name = domainKey(domain.name);
  const db = getDb();
  const holder = (await db.transaction((tx) => domainClaims(tx, name))).find((claim) => claim.workspaceId !== input.workspaceId);
  if (!holder) throw new DomainClaimError(`${name} isn't on anywhere else. Turn it on instead`);

  const [recent] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(domainAccessRequests)
    .where(
      and(
        eq(domainAccessRequests.domainName, name),
        eq(domainAccessRequests.requesterWorkspaceId, input.workspaceId),
        gt(domainAccessRequests.createdAt, new Date(now.getTime() - ACCESS_REQUEST_EVERY_MS)),
      ),
    );
  if ((recent?.count ?? 0) > 0) throw new DomainClaimError("You've already asked for this domain. Try again in a week");
  const [today] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(domainAccessRequests)
    .where(and(eq(domainAccessRequests.requestedBy, input.userId), gt(domainAccessRequests.createdAt, new Date(now.getTime() - DAY_MS))));
  if ((today?.count ?? 0) >= ACCESS_REQUESTS_PER_DAY) throw new DomainClaimError("Too many requests today. Try again tomorrow");

  await db.insert(domainAccessRequests).values({ domainName: name, requesterWorkspaceId: input.workspaceId, requestedBy: input.userId });
  const [[asker], [askerWorkspace], [holderWorkspace]] = await Promise.all([
    db.select({ name: user.name, email: user.email }).from(user).where(eq(user.id, input.userId)),
    db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, input.workspaceId)),
    db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, holder.workspaceId)),
  ]);
  await email(await adminEmails(holder.workspaceId), {
    kind: "access",
    domain: name,
    workspace: holderWorkspace?.name ?? "your workspace",
    requester: { name: asker?.name ?? "", email: asker?.email ?? "", workspace: askerWorkspace?.name ?? "" },
  });
  await audit(holder.workspaceId, null, "domain.access_requested", name, { requesterWorkspaceId: input.workspaceId });
}
