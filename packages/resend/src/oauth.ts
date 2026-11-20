import { createHash, randomBytes } from "node:crypto";
import { getResendOAuthEnv } from "@hellobox/config";

const API = "https://api.resend.com";
const USER_AGENT = "hellobox/1.0";

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scope?: string;
}

export class OAuthGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthGrantError";
  }
}

export function createPkce() {
  const verifier = randomBytes(64).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge, state: randomBytes(24).toString("base64url") };
}

export function buildAuthorizeUrl(input: {
  redirectUri: string;
  state: string;
  challenge: string;
}) {
  const url = new URL(`${API}/oauth/authorize`);
  url.search = new URLSearchParams({
    client_id: getResendOAuthEnv().RESEND_OAUTH_CLIENT_ID,
    response_type: "code",
    redirect_uri: input.redirectUri,
    scope: "full_access",
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

function basicAuth() {
  const { RESEND_OAUTH_CLIENT_ID, RESEND_OAUTH_CLIENT_SECRET } =
    getResendOAuthEnv();
  const raw = `${RESEND_OAUTH_CLIENT_ID}:${RESEND_OAUTH_CLIENT_SECRET}`;
  return `Basic ${Buffer.from(raw).toString("base64")}`;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenSet> {
  const res = await fetch(`${API}/oauth/token`, {
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
  if (!res.ok || !data.access_token || !data.refresh_token) {
    // A rejected grant needs the user to reconnect. Anything else may be transient.
    if (data.error === "invalid_grant") {
      throw new OAuthGrantError("Resend rejected the grant");
    }
    throw new Error(`Resend token request failed with status ${res.status}`);
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + (data.expires_in ?? 900) * 1000),
    scope: data.scope,
  };
}

export function exchangeCode(input: {
  code: string;
  redirectUri: string;
  verifier: string;
}) {
  return tokenRequest({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.verifier,
  });
}

export function refreshTokens(refreshToken: string) {
  return tokenRequest({
    grant_type: "refresh_token",
    client_id: getResendOAuthEnv().RESEND_OAUTH_CLIENT_ID,
    refresh_token: refreshToken,
  });
}

export async function revokeGrant(refreshToken: string) {
  await fetch(`${API}/oauth/revoke`, {
    method: "POST",
    headers: {
      Authorization: basicAuth(),
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: new URLSearchParams({
      token: refreshToken,
      token_type_hint: "refresh_token",
    }),
  });
}
