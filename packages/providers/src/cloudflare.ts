import { getCloudflareOAuthEnv } from "@hellobox/config";
import { keepsExisting, txtTag } from "./dns";
import type { DnsRecord } from "./types";

const OAUTH = "https://dash.cloudflare.com/oauth2";
const API = "https://api.cloudflare.com/client/v4";
const USER_AGENT = "hellobox/1.0";

// Finding the domain's zone, and writing its records. offline_access asks for a refresh
// token, so the grant outlives the first access token.
export const CLOUDFLARE_SCOPES = ["zone.read", "dns.write", "offline_access"];

export interface CloudflareTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scope?: string;
}

export class CloudflareGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudflareGrantError";
  }
}

export function buildCloudflareAuthorizeUrl(input: { redirectUri: string; state: string; challenge: string }) {
  const url = new URL(`${OAUTH}/auth`);
  url.search = new URLSearchParams({
    client_id: getCloudflareOAuthEnv().CF_CLIENT_ID,
    response_type: "code",
    redirect_uri: input.redirectUri,
    scope: CLOUDFLARE_SCOPES.join(" "),
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

function basicAuth() {
  const { CF_CLIENT_ID, CF_CLIENT_SECRET } = getCloudflareOAuthEnv();
  return `Basic ${Buffer.from(`${CF_CLIENT_ID}:${CF_CLIENT_SECRET}`).toString("base64")}`;
}

async function tokenRequest(body: Record<string, string>): Promise<CloudflareTokens> {
  const res = await fetch(`${OAUTH}/token`, {
    method: "POST",
    headers: {
      Authorization: basicAuth(),
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: new URLSearchParams(body),
  });
  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
  };
  if (!res.ok || !data.access_token) {
    // A rejected grant needs the user to reconnect. Anything else may be transient.
    if (data.error === "invalid_grant") throw new CloudflareGrantError("Cloudflare rejected the grant");
    throw new Error(`Cloudflare token request failed with status ${res.status}`);
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null,
    scope: data.scope,
  };
}

export function exchangeCloudflareCode(input: { code: string; redirectUri: string; verifier: string }) {
  return tokenRequest({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.verifier,
  });
}

export function refreshCloudflareTokens(refreshToken: string) {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
}

export async function revokeCloudflareToken(token: string) {
  await fetch(`${OAUTH}/revoke`, {
    method: "POST",
    headers: {
      Authorization: basicAuth(),
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: new URLSearchParams({ token }),
  });
}

interface CloudflareRecord {
  id: string;
  type: string;
  content: string;
  priority?: number;
}

export class CloudflareDns {
  constructor(private readonly accessToken: string) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
    });
    const data = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      result?: T;
      errors?: { message?: string }[];
    };
    if (res.status === 401) throw new CloudflareGrantError("Cloudflare no longer accepts this connection");
    if (!res.ok || !data.success) {
      throw new Error(data.errors?.[0]?.message ?? `Cloudflare request failed with status ${res.status}`);
    }
    return data.result as T;
  }

  // The zone with the longest name that the domain falls under, among those we were given.
  async findZone(domain: string) {
    const labels = domain.split(".");
    for (let i = 0; i < labels.length - 1; i++) {
      const name = labels.slice(i).join(".");
      const zones = await this.request<{ id: string }[]>(`/zones?name=${encodeURIComponent(name)}`);
      if (zones[0]) return zones[0].id;
    }
    return null;
  }

  // Adds or updates each record, the same way Route 53 is handled.
  async apply(domain: string, records: DnsRecord[]) {
    const zone = await this.findZone(domain);
    if (!zone) return { zone: null, applied: [] as DnsRecord[], skipped: records };
    const applied: DnsRecord[] = [];
    const skipped: DnsRecord[] = [];
    for (const record of records) {
      const existing = await this.request<CloudflareRecord[]>(
        `/zones/${zone}/dns_records?type=${record.type}&name=${encodeURIComponent(record.name)}`,
      );
      const values = existing.map((entry) =>
        entry.type === "MX" ? `${entry.priority ?? 0} ${entry.content}` : entry.content.replace(/^"|"$/g, ""),
      );
      if (keepsExisting(record, values)) {
        skipped.push(record);
        continue;
      }
      // TXT names can hold several records, so only one of the same kind is ours to update.
      const match =
        record.type === "TXT"
          ? existing.find((entry) => txtTag(entry.content) === txtTag(record.value))
          : record.type === "MX"
            ? existing.find((entry) => entry.content === record.value)
            : existing[0];
      const body = {
        type: record.type,
        name: record.name,
        content: record.value,
        ttl: 1,
        ...(record.type === "CNAME" ? { proxied: false } : {}),
        ...(record.priority !== undefined ? { priority: record.priority } : {}),
      };
      const current = match && (match.type === "TXT" ? match.content.replace(/^"|"$/g, "") : match.content);
      if (match && current === record.value && (record.priority === undefined || match.priority === record.priority)) {
        applied.push(record);
        continue;
      }
      await this.request(match ? `/zones/${zone}/dns_records/${match.id}` : `/zones/${zone}/dns_records`, {
        method: match ? "PATCH" : "POST",
        body: JSON.stringify(body),
      });
      applied.push(record);
    }
    return { zone, applied, skipped };
  }
}
