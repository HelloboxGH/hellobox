import { getEnv } from "@hellobox/config";
import { agentTokens, getDb } from "@hellobox/db";
import { emitEvent } from "@hellobox/extensions";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { allActions } from "@/core/server/actions-manifest";
import { createAgentEndpoint } from "@/core/server/agents/server";

// The remote MCP server agents connect to, with a token from Settings, Agents.
const serve = createAgentEndpoint({
  lookup: {
    findByHash: async (hash) => {
      const [row] = await getDb().select().from(agentTokens).where(eq(agentTokens.tokenHash, hash));
      return row;
    },
    // A write a minute at most, however busy the agent is.
    touch: (id) => {
      const now = new Date();
      return getDb()
        .update(agentTokens)
        .set({ lastUsedAt: now })
        .where(
          and(
            eq(agentTokens.id, id),
            or(isNull(agentTokens.lastUsedAt), lt(agentTokens.lastUsedAt, new Date(now.getTime() - 60_000))),
          ),
        );
    },
  },
  actions: allActions,
  audit: ({ agent, tool, target }) =>
    emitEvent({
      name: `agent.${tool}`,
      workspaceId: agent.workspaceId,
      userId: agent.userId,
      target,
      metadata: { agentTokenId: agent.tokenId, agentName: agent.name },
    }),
  // Browsers may only call from the app itself. MCP clients send no Origin.
  allowedOrigins: () => [new URL(getEnv().APP_URL).hostname],
});

export const POST = serve;
export const GET = serve;
export const DELETE = serve;
