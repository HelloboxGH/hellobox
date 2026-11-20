import { decrypt, encrypt, isCloudflareConfigured } from "@hellobox/config";
import { dnsConnections, getDb } from "@hellobox/db";
import {
  CloudflareDns,
  CloudflareGrantError,
  isOnCloudflare,
  refreshCloudflareTokens,
  revokeCloudflareToken,
  type CloudflareTokens,
} from "@hellobox/providers";
import { and, eq } from "drizzle-orm";

const REFRESH_EARLY_MS = 60_000;

const ofWorkspace = (workspaceId: string) =>
  and(eq(dnsConnections.workspaceId, workspaceId), eq(dnsConnections.provider, "cloudflare"));

const tokenValues = (tokens: CloudflareTokens) => ({
  accessTokenEnc: encrypt(tokens.accessToken),
  refreshTokenEnc: tokens.refreshToken ? encrypt(tokens.refreshToken) : null,
  accessExpiresAt: tokens.expiresAt,
  scope: tokens.scope ?? null,
});

// Reconnecting replaces the grant.
export async function saveCloudflareGrant(workspaceId: string, tokens: CloudflareTokens) {
  await getDb()
    .insert(dnsConnections)
    .values({ workspaceId, provider: "cloudflare", ...tokenValues(tokens) })
    .onConflictDoUpdate({ target: [dnsConnections.workspaceId, dnsConnections.provider], set: tokenValues(tokens) });
}

// A client for the workspace's Cloudflare grant, refreshed when it's about to expire. A
// grant Cloudflare no longer accepts is forgotten, so the UI offers to connect again.
export async function cloudflareFor(workspaceId: string) {
  if (!isCloudflareConfigured()) return null;
  const db = getDb();
  const [row] = await db.select().from(dnsConnections).where(ofWorkspace(workspaceId));
  if (!row) return null;
  const expiring = row.accessExpiresAt && row.accessExpiresAt.getTime() - Date.now() < REFRESH_EARLY_MS;
  if (!expiring) return new CloudflareDns(decrypt(row.accessTokenEnc));
  try {
    if (!row.refreshTokenEnc) throw new CloudflareGrantError("The Cloudflare grant expired");
    const tokens = await refreshCloudflareTokens(decrypt(row.refreshTokenEnc));
    await db.update(dnsConnections).set(tokenValues(tokens)).where(eq(dnsConnections.id, row.id));
    return new CloudflareDns(tokens.accessToken);
  } catch (error) {
    if (!(error instanceof CloudflareGrantError)) throw error;
    await db.delete(dnsConnections).where(eq(dnsConnections.id, row.id));
    return null;
  }
}

export async function disconnectCloudflare(workspaceId: string) {
  const db = getDb();
  const [row] = await db.select().from(dnsConnections).where(ofWorkspace(workspaceId));
  if (!row) return;
  await revokeCloudflareToken(decrypt(row.refreshTokenEnc ?? row.accessTokenEnc)).catch(() => undefined);
  await db.delete(dnsConnections).where(eq(dnsConnections.id, row.id));
}

export interface CloudflareStatus {
  // The domain's nameservers are Cloudflare's, so we can offer to write its records there.
  onCloudflare: boolean;
  connected: boolean;
}

export async function cloudflareStatus(workspaceId: string, domain: string): Promise<CloudflareStatus> {
  if (!isCloudflareConfigured()) return { onCloudflare: false, connected: false };
  const [onCloudflare, [row]] = await Promise.all([
    isOnCloudflare(domain),
    getDb().select({ id: dnsConnections.id }).from(dnsConnections).where(ofWorkspace(workspaceId)),
  ]);
  return { onCloudflare, connected: Boolean(row) };
}

// Writes the records to Cloudflare. A grant that stops working mid-way is forgotten.
export async function applyCloudflare(workspaceId: string, domain: string, records: Parameters<CloudflareDns["apply"]>[1]) {
  const dns = await cloudflareFor(workspaceId);
  if (!dns) return null;
  try {
    return await dns.apply(domain, records);
  } catch (error) {
    if (!(error instanceof CloudflareGrantError)) throw error;
    await getDb().delete(dnsConnections).where(ofWorkspace(workspaceId));
    return null;
  }
}
