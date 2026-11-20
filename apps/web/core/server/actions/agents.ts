import { agentTokens, getDb } from "@hellobox/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { forbidden, notFound } from "nezt";
import { z } from "zod";
import { workspaceAction } from "../builder";
import { emit } from "../events";
import type { WorkspaceContext } from "../middlewares";
import { AGENT_SCOPES, AGENT_TOKEN_LIFETIMES, normalizeScopes } from "@/core/agent-scopes";
import { generateAgentToken } from "../agents/tokens";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ACTIVE_TOKENS = 25;

// Agents can't hand themselves more access, so token management is for people only.
function assertPerson(ctx: WorkspaceContext) {
  if (ctx.agent) throw forbidden("Agents can't manage agent connections");
}

const tokenColumns = {
  id: agentTokens.id,
  name: agentTokens.name,
  hint: agentTokens.hint,
  scopes: agentTokens.scopes,
  expiresAt: agentTokens.expiresAt,
  lastUsedAt: agentTokens.lastUsedAt,
  createdAt: agentTokens.createdAt,
};

// Each person sees only their own connections, in the current workspace.
export const listAgentTokens = workspaceAction("/agents/list").handler(async ({ ctx }) => {
  assertPerson(ctx);
  return getDb()
    .select(tokenColumns)
    .from(agentTokens)
    .where(
      and(
        eq(agentTokens.workspaceId, ctx.workspace.id),
        eq(agentTokens.userId, ctx.user.id),
        isNull(agentTokens.revokedAt),
      ),
    )
    .orderBy(desc(agentTokens.createdAt))
    .limit(MAX_ACTIVE_TOKENS);
});

// The token is returned once, here. Only its hash is stored.
export const createAgentToken = workspaceAction("/agents/create")
  .input(
    z.object({
      name: z.string().trim().min(1, "Name the connection").max(60),
      scopes: z.array(z.enum(AGENT_SCOPES)).min(1),
      days: z.union(AGENT_TOKEN_LIFETIMES.map((days) => z.literal(days))).default(90),
    }),
  )
  .handler(async ({ input, ctx }) => {
    assertPerson(ctx);
    const db = getDb();
    const active = await db
      .select({ id: agentTokens.id })
      .from(agentTokens)
      .where(
        and(
          eq(agentTokens.workspaceId, ctx.workspace.id),
          eq(agentTokens.userId, ctx.user.id),
          isNull(agentTokens.revokedAt),
        ),
      );
    if (active.length >= MAX_ACTIVE_TOKENS) {
      throw forbidden(`You can have up to ${MAX_ACTIVE_TOKENS} agent connections. Revoke one first`);
    }
    const { token, hash, hint } = generateAgentToken();
    const scopes = normalizeScopes(input.scopes);
    const [created] = await db
      .insert(agentTokens)
      .values({
        workspaceId: ctx.workspace.id,
        userId: ctx.user.id,
        name: input.name,
        tokenHash: hash,
        hint,
        scopes,
        expiresAt: new Date(Date.now() + input.days * DAY_MS),
      })
      .returning(tokenColumns);
    if (!created) throw new Error("Could not create the connection");
    await emit(ctx, "agent.connected", created.id, { name: created.name, scopes });
    return { ...created, token };
  });

export const revokeAgentToken = workspaceAction("/agents/revoke")
  .input(z.object({ id: z.string() }))
  .handler(async ({ input, ctx }) => {
    assertPerson(ctx);
    const [revoked] = await getDb()
      .update(agentTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(agentTokens.id, input.id),
          eq(agentTokens.workspaceId, ctx.workspace.id),
          eq(agentTokens.userId, ctx.user.id),
          isNull(agentTokens.revokedAt),
        ),
      )
      .returning({ id: agentTokens.id, name: agentTokens.name });
    if (!revoked) throw notFound("Connection");
    await emit(ctx, "agent.revoked", revoked.id, { name: revoked.name });
    return { ok: true };
  });

export const agentActions = {
  "/agents/list": listAgentTokens,
  "/agents/create": createAgentToken,
  "/agents/revoke": revokeAgentToken,
};
