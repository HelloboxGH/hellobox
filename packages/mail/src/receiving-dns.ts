import { domains, getDb } from "@hellobox/db";
import { CloudflareGrantError, type CloudflareRecord, type DnsRecord } from "@hellobox/providers";
import { and, eq, isNull } from "drizzle-orm";
import { applyCloudflare, cloudflareFor } from "./cloudflare";
import { helloboxMxHost, helloboxMxRecord, ReceivingError } from "./mx";
import { txtRecordFor } from "./takeovers";

// Writing the records for receiving with HelloBox to Cloudflare. The order is the point:
// the TXT record goes first, and the MX record only once the domain is confirmed here. An
// MX that moves earlier makes the mail server refuse the domain's mail for good (550).
// Anything that goes wrong leaves the records to be added by hand.

// The part of the Cloudflare client this needs, so tests can fake it.
export interface MxDns {
  recordsAt(domain: string, type: "MX", name: string): Promise<{ zone: string; records: CloudflareRecord[] } | null>;
  createRecord(zone: string, record: DnsRecord): Promise<void>;
  deleteRecord(zone: string, id: string): Promise<void>;
}

export interface ExistingMx {
  id: string;
  value: string;
  priority: number;
}

export type MxPlan =
  | { state: "none"; zone: string }
  // Ours is there alone.
  | { state: "ours"; zone: string; ours: ExistingMx }
  // Others are there, with or without ours: they'd have to go.
  | { state: "others"; zone: string; others: ExistingMx[]; hasOurs: boolean };

const clean = (value: string) => value.trim().toLowerCase().replace(/\.$/, "");

// Reads the MX records on exactly this name and sorts them into ours and not ours.
export async function planHelloboxMx(dns: MxDns, domain: string, host: string): Promise<MxPlan> {
  const found = await dns.recordsAt(domain, "MX", domain);
  if (!found) throw new ReceivingError(`We couldn't find ${domain} in your Cloudflare account. Add the record by hand instead.`);
  const all = found.records.map((record) => ({ id: record.id, value: clean(record.content), priority: record.priority ?? 0 }));
  const ours = all.filter((record) => record.value === clean(host));
  const others = all.filter((record) => record.value !== clean(host));
  if (others.length) return { state: "others", zone: found.zone, others, hasOurs: ours.length > 0 };
  if (ours.length) return { state: "ours", zone: found.zone, ours: ours[0] as ExistingMx };
  return { state: "none", zone: found.zone };
}

export type MxResult =
  | { status: "added" | "replaced" | "already" }
  // Nothing changed yet: the user has to confirm that these stop getting mail.
  | { status: "needs-confirmation"; existing: { value: string; priority: number }[] };

// Adds our MX, after the user confirmed replacing the others when there are some. Ours goes
// in before the others come out, so a failure to add leaves the domain as it was.
export async function applyHelloboxMx(dns: MxDns, domain: string, host: string, replace: boolean): Promise<MxResult> {
  const plan = await planHelloboxMx(dns, domain, host);
  if (plan.state === "ours") return { status: "already" };
  if (plan.state === "others") {
    if (!replace) return { status: "needs-confirmation", existing: plan.others.map(({ value, priority }) => ({ value, priority })) };
    if (!plan.hasOurs) await dns.createRecord(plan.zone, helloboxMxRecordFor(domain, host));
    for (const other of plan.others) await dns.deleteRecord(plan.zone, other.id);
    return { status: "replaced" };
  }
  await dns.createRecord(plan.zone, helloboxMxRecordFor(domain, host));
  return { status: "added" };
}

// Takes our MX record off the domain, and nothing else.
export async function removeHelloboxMx(dns: MxDns, domain: string, host: string) {
  const found = await dns.recordsAt(domain, "MX", domain);
  if (!found) throw new ReceivingError(`We couldn't find ${domain} in your Cloudflare account. Remove the record by hand instead.`);
  const ours = found.records.filter((record) => clean(record.content) === clean(host));
  for (const record of ours) await dns.deleteRecord(found.zone, record.id);
  return ours.length;
}

const helloboxMxRecordFor = (domain: string, host: string): DnsRecord => ({
  ...helloboxMxRecord(domain, host),
  purpose: "Sends this domain's mail to HelloBox",
});

async function dnsOrThrow(workspaceId: string) {
  const dns = await cloudflareFor(workspaceId);
  if (!dns) throw new ReceivingError("Cloudflare isn't connected. Add the record by hand instead.");
  return dns;
}

// A Cloudflare failure becomes something to tell the user, with the by-hand fallback.
async function guarded<T>(workspaceId: string, run: () => Promise<T>) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ReceivingError) throw error;
    if (error instanceof CloudflareGrantError) {
      throw new ReceivingError("Cloudflare no longer accepts the connection. Reconnect it, or add the record by hand.");
    }
    const detail = error instanceof Error ? error.message : "";
    throw new ReceivingError(
      `Cloudflare didn't accept the change${detail ? ` (${detail})` : ""}. The connection may lack permission to edit DNS. Add the record by hand instead.`,
    );
  }
}

async function domainOf(workspaceId: string, domainId: string) {
  const [domain] = await getDb()
    .select()
    .from(domains)
    .where(and(eq(domains.id, domainId), eq(domains.workspaceId, workspaceId), isNull(domains.removedAt)));
  if (!domain) throw new ReceivingError("That domain isn't in this workspace");
  return domain;
}

export function addHelloboxTxtToCloudflare(workspaceId: string, domainId: string) {
  return guarded(workspaceId, async () => {
    const domain = await domainOf(workspaceId, domainId);
    if (!domain.receiveToken) throw new ReceivingError("Start receiving with HelloBox first");
    const record = { ...txtRecordFor(domain.name, domain.receiveToken), purpose: "Proves you control this domain to HelloBox" };
    const result = await applyCloudflare(workspaceId, domain.name, [record]);
    if (!result) throw new ReceivingError("Cloudflare isn't connected. Add the record by hand instead.");
    if (!result.zone) throw new ReceivingError(`We couldn't find ${domain.name} in your Cloudflare account. Add the record by hand instead.`);
    return { applied: result.applied.length > 0 };
  });
}

// Only once receiving is on: before that the mail server would refuse the domain's mail.
export function pointMxToHellobox(workspaceId: string, domainId: string, replace: boolean) {
  return guarded(workspaceId, async () => {
    const domain = await domainOf(workspaceId, domainId);
    if (!domain.receiveWithHellobox) throw new ReceivingError("Turn receiving on first, so the mail server knows this domain");
    const host = helloboxMxHost();
    if (!host) throw new ReceivingError("Receiving with HelloBox isn't set up on this server");
    return applyHelloboxMx(await dnsOrThrow(workspaceId), domain.name, host, replace);
  });
}

export function removeHelloboxMxFromCloudflare(workspaceId: string, domainId: string) {
  return guarded(workspaceId, async () => {
    const domain = await domainOf(workspaceId, domainId);
    const host = helloboxMxHost();
    if (!host) throw new ReceivingError("Receiving with HelloBox isn't set up on this server");
    return { removed: await removeHelloboxMx(await dnsOrThrow(workspaceId), domain.name, host) };
  });
}
