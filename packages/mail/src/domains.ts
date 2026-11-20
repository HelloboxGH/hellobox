import { connections, domains, getDb } from "@hellobox/db";
import { and, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { fitsPlan, planDomainCount } from "./domain-names";

type ConnectionStatus = (typeof connections.$inferSelect)["status"];

// A domain takes a place on the plan while it's on, still in HelloBox, and its connection
// hasn't been disconnected. Domains on a disconnected connection keep their mail without
// using up the plan.
export function countsAgainstPlan(
  domain: { enabled: boolean; removedAt: Date | string | null },
  connectionStatus: ConnectionStatus | undefined,
) {
  return domain.enabled && !domain.removedAt && connectionStatus !== "disconnected";
}

// The same rule as countsAgainstPlan, for queries that join connections.
export const countedDomain = () =>
  and(eq(domains.enabled, true), isNull(domains.removedAt), ne(connections.status, "disconnected"));

// Mail on a domain removed from HelloBox stays readable. Domains switched off (by hand or to
// fit the plan) hide theirs until they're back on. Needs mailboxes and domains joined.
export const shownDomain = () => or(eq(domains.enabled, true), isNotNull(domains.removedAt));

// Whether new mail for a domain comes in through this copy of it, given every copy of the
// domain still in HelloBox (see domainCopies). Only one workspace ever takes it, so no
// other workspace can see someone's new mail:
// - a removed domain takes none, whoever removed it or had it claimed away;
// - otherwise the workspace with the best copy takes it: verified by its provider before
//   not, then on before off, then the earliest. So the place that has it on (see
//   domainClaims) gets it, and when nobody has it on, a switched-off copy keeps it hidden
//   until it's back on (see shownDomain), so a plan downgrade doesn't lose mail.
// Inside that workspace every copy still takes it, since one provider may send for the
// domain while another receives it.
export function receivesMail(
  domain: { id: string; workspaceId: string; removedAt: Date | string | null },
  copies: { domainId: string; workspaceId: string; enabled: boolean; status: string | null; createdAt: Date }[],
) {
  if (domain.removedAt) return false;
  const rank = (copy: (typeof copies)[number]) => (copy.status === "verified" ? 2 : 0) + (copy.enabled ? 1 : 0);
  const best = [...copies].sort(
    (a, b) => rank(b) - rank(a) || a.createdAt.getTime() - b.createdAt.getTime() || a.domainId.localeCompare(b.domainId),
  )[0];
  return best?.workspaceId === domain.workspaceId;
}

// Only domains that are on and still in HelloBox notify anyone about new mail.
export function notifiesFor(domain: { enabled: boolean; removedAt: Date | string | null }) {
  return domain.enabled && !domain.removedAt;
}

// The same rule as notifiesFor, for queries that join domains.
export const notifyingDomain = () => and(eq(domains.enabled, true), isNull(domains.removedAt));

export async function countedDomainNames(workspaceId: string) {
  const rows = await getDb()
    .select({ name: domains.name })
    .from(domains)
    .innerJoin(connections, eq(connections.id, domains.connectionId))
    .where(and(eq(domains.workspaceId, workspaceId), countedDomain()));
  return rows.map((row) => row.name);
}

// Places taken on the plan. Subdomains count under their parent (see planDomainCount).
export async function countActiveDomains(workspaceId: string) {
  return planDomainCount(await countedDomainNames(workspaceId));
}

interface Candidate {
  id: string;
  name: string;
  enabled: boolean;
  removedAt: Date | string | null;
  connectionStatus: ConnectionStatus;
}

// Where a removed domain's mailboxes go: the same domain on another connection, preferring
// one that's on and connected. Without one, they stay on the removed domain.
export function successorFor(removed: { id: string; name: string }, candidates: Candidate[]) {
  const rank = (c: Candidate) => (c.enabled ? 2 : 0) + (c.connectionStatus === "active" ? 1 : 0);
  return (
    candidates
      .filter((c) => c.id !== removed.id && c.name === removed.name && !c.removedAt && c.connectionStatus !== "disconnected")
      .sort((a, b) => rank(b) - rank(a))[0] ?? null
  );
}

// Brings a removed domain back, turning it on when the plan has room and no one else
// has the domain on.
export async function restoreDomain(domainId: string, workspaceId: string, domainLimit: number) {
  const db = getDb();
  const [domain] = await db
    .select({ id: domains.id, name: domains.name, enabled: domains.enabled, removedAt: domains.removedAt })
    .from(domains)
    .where(and(eq(domains.id, domainId), eq(domains.workspaceId, workspaceId)));
  if (!domain) return null;
  if (!domain.removedAt) return { enabled: domain.enabled, restored: false, offBecause: null };
  const fits = fitsPlan(await countedDomainNames(workspaceId), domain.name, domainLimit);
  return db.transaction(async (tx) => {
    await lockDomainName(tx, domain.name);
    const taken = claimConflict(await domainClaims(tx, domain.name), { domainId: domain.id, workspaceId });
    const enabled = fits && !taken;
    await tx.update(domains).set({ removedAt: null, enabled }).where(eq(domains.id, domain.id));
    return { enabled, restored: true, offBecause: taken ? ("claimed" as const) : enabled ? null : ("plan" as const) };
  });
}

// A domain can be on in only one place: one workspace, through one connection. The place
// that has it is the claim: a domain that's on, still in HelloBox and verified by its
// provider. Anyone can add a domain to their own provider account without owning it, so an
// unverified one blocks no one. The claim survives a disconnect, since rotating a key
// shouldn't cost anyone their domain; removing the domain releases it. Demo sandboxes all
// share one domain, so they claim nothing.

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

export type ClaimConflict = "this-workspace" | "other-workspace";

export const domainKey = (name: string) => name.trim().toLowerCase().replace(/\.$/, "");

// Who else has the domain on, from the claims domainClaims found.
export function claimConflict(
  claims: { domainId: string; workspaceId: string }[],
  self: { domainId?: string; workspaceId: string },
): ClaimConflict | null {
  const others = claims.filter((claim) => claim.domainId !== self.domainId);
  if (!others.length) return null;
  return others.some((claim) => claim.workspaceId === self.workspaceId) ? "this-workspace" : "other-workspace";
}

// What someone turning a domain on is told when it's taken. Nothing about another
// workspace is said until their own provider has verified the domain: before that, they
// haven't shown they have anything to do with it.
export function claimConflictMessage(name: string, conflict: ClaimConflict, verified: boolean) {
  if (conflict === "this-workspace") {
    return `${name} is already on through another provider in this workspace. Remove it there first`;
  }
  if (!verified) return `Verify ${name} with your provider first`;
  return `${name} is already in use in another HelloBox workspace`;
}

// Held until the transaction ends, so two workspaces turning the same domain on at once
// can't both find it free.
export async function lockDomainName(tx: Tx, name: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`domain-claim:${domainKey(name)}`}))`);
}

// Which of these domain rows take new mail (see receivesMail).
export async function receivingDomainIds(rows: { id: string; workspaceId: string; name: string; removedAt: Date | string | null }[]) {
  const receiving = new Set<string>();
  for (const name of new Set(rows.map((row) => domainKey(row.name)))) {
    const copies = await domainCopies(name);
    for (const row of rows) {
      if (domainKey(row.name) === name && receivesMail(row, copies)) receiving.add(row.id);
    }
  }
  return receiving;
}

// Every copy of a domain still in HelloBox, in any workspace. Demo sandboxes share one
// domain among themselves and take their mail separately (see resolveMailbox).
export function domainCopies(name: string) {
  return getDb()
    .select({
      domainId: domains.id,
      workspaceId: domains.workspaceId,
      enabled: domains.enabled,
      status: domains.status,
      createdAt: domains.createdAt,
    })
    .from(domains)
    .innerJoin(connections, eq(connections.id, domains.connectionId))
    .where(
      and(sql`lower(rtrim(${domains.name}, '.')) = ${domainKey(name)}`, isNull(domains.removedAt), ne(connections.provider, "demo")),
    );
}

export function domainClaims(tx: Tx | ReturnType<typeof getDb>, name: string) {
  return tx
    .select({ domainId: domains.id, workspaceId: domains.workspaceId })
    .from(domains)
    .innerJoin(connections, eq(connections.id, domains.connectionId))
    .where(
      and(
        sql`lower(rtrim(${domains.name}, '.')) = ${domainKey(name)}`,
        eq(domains.enabled, true),
        isNull(domains.removedAt),
        eq(domains.status, "verified"),
        ne(connections.provider, "demo"),
      ),
    );
}
