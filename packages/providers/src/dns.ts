import { resolveNs, resolveTxt } from "node:dns/promises";
import type { DnsRecord } from "./types";

// A name with no NS records of its own sits inside a parent's zone.
const NOT_A_ZONE = new Set(["ENODATA", "ENOTFOUND"]);

// The nameservers of the zone the domain belongs to, found by walking up its labels.
export async function nameserversFor(domain: string) {
  const labels = domain.toLowerCase().replace(/\.$/, "").split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    try {
      const servers = await resolveNs(labels.slice(i).join("."));
      if (servers.length) return servers.map((server) => server.toLowerCase().replace(/\.$/, ""));
    } catch (error) {
      if (!NOT_A_ZONE.has((error as { code?: string }).code ?? "")) return [];
    }
  }
  return [];
}

export async function isOnCloudflare(domain: string) {
  return (await nameserversFor(domain)).some((server) => server.endsWith(".ns.cloudflare.com"));
}

async function txtValues(name: string) {
  try {
    return (await resolveTxt(name)).map((chunks) => chunks.join(""));
  } catch {
    return [];
  }
}

// A DMARC policy on the domain, or on the domain it's a subdomain of, already covers it.
export async function hasDmarcPolicy(domain: string) {
  const labels = domain.split(".");
  const names = [domain, ...(labels.length > 2 ? [labels.slice(-2).join(".")] : [])];
  for (const name of names) {
    if ((await txtValues(`_dmarc.${name}`)).some((value) => value.startsWith("v=DMARC1"))) return true;
  }
  return false;
}

// Monitoring only: receivers report what fails, and nothing gets rejected yet.
export const dmarcRecord = (domain: string): DnsRecord => ({
  type: "TXT",
  name: `_dmarc.${domain}`,
  value: "v=DMARC1; p=none;",
  purpose: "Tells inboxes your mail is authenticated, which Gmail and Yahoo require",
  keepExisting: true,
});

// The kind of TXT record, like v=spf1 or v=DMARC1, since a name can hold several.
export const txtTag = (value: string) => value.replace(/^"|"$/g, "").split(/[;\s]/)[0] ?? "";

// Whether a record should leave what the domain already has alone.
export function keepsExisting(record: DnsRecord, existing: string[]) {
  if (!record.keepExisting) return false;
  if (record.type === "MX") return existing.length > 0 && !existing.every((value) => value.includes(record.value));
  return existing.some((value) => txtTag(value) === txtTag(record.value) && value.replace(/^"|"$/g, "") !== record.value);
}
