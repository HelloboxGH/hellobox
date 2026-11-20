import { hasDmarcPolicy, resendDomainRecords } from "@hellobox/providers";
import type { ResendClient } from "@hellobox/resend";
import { cloudflareStatus } from "./cloudflare";
import { clientForConnection, loadConnection } from "./connections";
import { importAddedDomain, normalizeDomain, withDns, type DnsHost } from "./ses";

// Resend domains, for receiving on a subdomain. Other domains are still added in Resend's
// dashboard, but their records show here the same way.

async function activeResend(connectionId: string, workspaceId: string) {
  const connection = await loadConnection(connectionId);
  if (connection.workspaceId !== workspaceId || connection.provider !== "resend") {
    throw new Error("Resend connection not found");
  }
  if (connection.status !== "active") throw new Error("This Resend connection isn't active. Reconnect it first.");
  return { connection, client: clientForConnection(connectionId) };
}

async function findDomain(client: ResendClient, name: string) {
  const domain = (await client.listDomains()).find((candidate) => candidate.name.toLowerCase() === name);
  if (!domain) throw new Error(`${name} isn't in this Resend account`);
  return domain;
}

async function records(client: ResendClient, id: string, name: string) {
  const details = await client.getDomain(id);
  return resendDomainRecords(name, details.records ?? [], { needsDmarc: !(await hasDmarcPolicy(name)) });
}

// Adds the domain with receiving on, or turns receiving on when it's already there.
export async function addResendReceivingDomain(connectionId: string, workspaceId: string, name: string) {
  const { connection, client } = await activeResend(connectionId, workspaceId);
  const domain = normalizeDomain(name);
  const existing = await findDomain(client, domain).catch(() => null);
  let id: string;
  if (existing) {
    id = existing.id;
    if (existing.capabilities?.receiving !== "enabled") {
      await client.updateDomain(id, { capabilities: { receiving: "enabled" } });
    }
  } else {
    id = (await client.createDomain(domain, { sending: "enabled", receiving: "enabled" })).id;
  }
  const setup = await withDns(connection, null, domain, await records(client, id, domain));
  await importAddedDomain(connectionId, workspaceId, domain);
  return setup;
}

export async function resendDomainSetup(connectionId: string, workspaceId: string, domain: string) {
  const { client } = await activeResend(connectionId, workspaceId);
  const [found, cloudflare] = await Promise.all([findDomain(client, domain), cloudflareStatus(workspaceId, domain)]);
  return { records: await records(client, found.id, domain), zoneFound: null, cloudflare };
}

export async function applyResendDomainDns(connectionId: string, workspaceId: string, domain: string, host: DnsHost) {
  const { connection, client } = await activeResend(connectionId, workspaceId);
  const found = await findDomain(client, domain);
  return withDns(connection, null, domain, await records(client, found.id, domain), host);
}

// Resend checks the records in the background, so the status changes a little later.
export async function verifyResendDomain(connectionId: string, workspaceId: string, domain: string) {
  const { client } = await activeResend(connectionId, workspaceId);
  await client.verifyDomain((await findDomain(client, domain)).id);
}
