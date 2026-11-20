import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { parseAdminEmails } from "@hellobox/config";

export const ADMIN_SESSION_HOURS = 12;
export const AUTH_CODE_SECONDS = 120;
// Approving the terminal needs a sign-in this recent, so a forgotten open tab can't.
export const FRESH_SIGN_IN_MINUTES = 10;

const TOKEN_PREFIX = "rbx_admin_";

// Admins are listed by email, so access goes with the address and not a database
// flag someone could set. Unset means nobody is an admin.
export function adminEmails(value = process.env.ADMIN_EMAILS) {
  return new Set(parseAdminEmails(value));
}

export const isAdminEmail = (email: string, allowlist = adminEmails()) =>
  allowlist.has(email.trim().toLowerCase());

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const base64url = (bytes: Buffer) => bytes.toString("base64url");

export function generateAdminToken() {
  const token = `${TOKEN_PREFIX}${base64url(randomBytes(32))}`;
  return { token, hash: sha256(token) };
}

export const looksLikeAdminToken = (token: string) =>
  token.startsWith(TOKEN_PREFIX) && /^[A-Za-z0-9_-]{43}$/.test(token.slice(TOKEN_PREFIX.length));

export function bearerToken(header: string | null | undefined) {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  return match?.[1] ?? null;
}

export function generateAuthCode() {
  const code = base64url(randomBytes(32));
  return { code, hash: sha256(code) };
}

// PKCE S256 as in RFC 7636: a 43 character base64url SHA-256 of the verifier.
export const isPkceChallenge = (value: string) => /^[A-Za-z0-9_-]{43}$/.test(value);
export const isPkceVerifier = (value: string) => /^[A-Za-z0-9._~-]{43,128}$/.test(value);

export function pkceMatches(verifier: string, challenge: string) {
  if (!isPkceVerifier(verifier) || !isPkceChallenge(challenge)) return false;
  const expected = Buffer.from(base64url(createHash("sha256").update(verifier).digest()));
  const given = Buffer.from(challenge);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// The code only ever goes back to the terminal's own listener on this computer.
export function loopbackCallback(port: number, code: string, state: string) {
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw new Error("Invalid port");
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(state)) throw new Error("Invalid state");
  const url = new URL(`http://127.0.0.1:${port}/callback`);
  url.searchParams.set("code", code);
  url.searchParams.set("state", state);
  return url.toString();
}

// Shown in the browser and in the terminal, so people can see they're approving
// the sign-in they started.
export const confirmationCode = (challenge: string) =>
  sha256(challenge).slice(0, 8).toUpperCase().replace(/^(.{4})/, "$1-");
