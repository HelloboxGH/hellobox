import { createHash, randomBytes } from "node:crypto";

const PREFIX = "rbx_agent_";

export const hashAgentToken = (token: string) => createHash("sha256").update(token).digest("hex");

export function generateAgentToken() {
  const token = `${PREFIX}${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashAgentToken(token), hint: token.slice(-4) };
}

// Saves a database lookup for strings that were never one of our tokens.
export const looksLikeAgentToken = (token: string) =>
  token.startsWith(PREFIX) && /^[A-Za-z0-9_-]{43}$/.test(token.slice(PREFIX.length));

export type AgentTokenProblem = "revoked" | "expired";

export function agentTokenProblem(
  row: { revokedAt: Date | null; expiresAt: Date },
  now = new Date(),
): AgentTokenProblem | null {
  if (row.revokedAt) return "revoked";
  if (row.expiresAt.getTime() <= now.getTime()) return "expired";
  return null;
}
