// Shared by the server, which enforces these, and Settings, which offers them.

export const AGENT_SCOPES = ["read", "write", "send"] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

export const AGENT_SCOPE_LABELS: Record<AgentScope, string> = {
  read: "Read mail, contacts, templates and campaigns",
  write: "Organize mail, write drafts, edit contacts and templates, and add domains",
  send: "Send email, replies and campaigns",
};

export const AGENT_TOKEN_LIFETIMES = [30, 90, 365] as const;

// Sending implies writing and writing implies reading, the way the app's own
// screens build on each other.
export function normalizeScopes(scopes: readonly AgentScope[]): AgentScope[] {
  const set = new Set<AgentScope>(scopes);
  if (set.has("send")) set.add("write");
  if (set.has("write")) set.add("read");
  set.add("read");
  return AGENT_SCOPES.filter((scope) => set.has(scope));
}

export const hasScope = (scopes: readonly string[], scope: AgentScope) => scopes.includes(scope);
