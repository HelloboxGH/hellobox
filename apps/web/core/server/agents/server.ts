import {
  type AuthInfo,
  createMcpHandler,
  McpServer,
  OAuthError,
  OAuthErrorCode,
  originValidationResponse,
  requireBearerAuth,
} from "@modelcontextprotocol/server";
import { type AgentIdentity, runAsAgent } from "./context";
import { hasScope } from "@/core/agent-scopes";
import { agentTokenProblem, hashAgentToken, looksLikeAgentToken } from "./tokens";
import { type AgentActions, type AgentTool, agentTools, describeToolError } from "./tools";

export interface AgentAuditEntry {
  agent: AgentIdentity;
  tool: string;
  target?: string;
}

export interface AgentServerDeps {
  agent: AgentIdentity;
  actions: AgentActions;
  audit: (entry: AgentAuditEntry) => Promise<unknown>;
  tools?: AgentTool[];
}

const INSTRUCTIONS = `HelloBox is a shared inbox and email platform for domains on Amazon SES, Resend, Postmark or Mailgun.
You act for one person, in one workspace, with exactly their role and mailbox access.
Start with get_workspace to learn their mailboxes and labels.
Sends wait 10 seconds before going out and can be stopped with cancel_send.
Ask the person before sending campaigns or anything they haven't approved.`;

const text = (value: unknown) => [{ type: "text" as const, text: JSON.stringify(value ?? null, null, 2) }];

// Runs one tool as the agent. Errors come back as tool results so the model can
// read them, and anything that changes data is written to the audit log.
export async function callAgentTool(definition: AgentTool, args: unknown, deps: AgentServerDeps) {
  const { agent, actions } = deps;
  if (!hasScope(agent.scopes, definition.scope)) {
    return {
      isError: true,
      content: text({
        code: "INSUFFICIENT_SCOPE",
        message: `This connection doesn't allow ${definition.scope} access. The user can create one that does in Settings, Agents`,
      }),
    };
  }
  try {
    const result = await runAsAgent(agent, () => definition.run(args as never, actions));
    if (definition.scope !== "read") {
      const target = definition.target?.(args as never, result as never);
      await deps.audit({ agent, tool: definition.name, target }).catch((error: unknown) => {
        console.error("[agents] Couldn't record an audit entry:", error);
      });
    }
    return { content: text(result) };
  } catch (error) {
    const described = describeToolError(error);
    if (described.code === "INTERNAL_ERROR") console.error(`[agents] ${definition.name} failed:`, error);
    return { isError: true, content: text(described) };
  }
}

// One server per request, holding only the tools this connection's scopes allow.
export function createAgentServer(deps: AgentServerDeps) {
  const server = new McpServer(
    { name: "hellobox", title: "HelloBox", version: "1.0.0", websiteUrl: "https://hellobox.app" },
    { instructions: INSTRUCTIONS },
  );
  for (const definition of deps.tools ?? agentTools) {
    if (!hasScope(deps.agent.scopes, definition.scope)) continue;
    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.input,
        annotations: {
          title: definition.title,
          readOnlyHint: definition.scope === "read",
          destructiveHint: definition.destructive ?? definition.scope === "send",
          openWorldHint: definition.scope === "send",
        },
      },
      (args: unknown) => callAgentTool(definition, args, deps),
    );
  }
  return server;
}

export interface AgentTokenRow {
  id: string;
  name: string;
  userId: string;
  workspaceId: string;
  scopes: string[];
  expiresAt: Date;
  revokedAt: Date | null;
}

const invalid = (message: string) => new OAuthError(OAuthErrorCode.InvalidToken, message);

// Turns a bearer token into the agent it stands for, or refuses it with a 401.
export function agentTokenVerifier(lookup: {
  findByHash: (hash: string) => Promise<AgentTokenRow | undefined>;
  touch: (id: string) => Promise<unknown>;
}) {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      if (!looksLikeAgentToken(token)) throw invalid("This isn't a HelloBox agent token");
      const row = await lookup.findByHash(hashAgentToken(token));
      if (!row) throw invalid("This token doesn't exist");
      const problem = agentTokenProblem(row);
      if (problem === "revoked") throw invalid("This token was revoked");
      if (problem === "expired") throw invalid("This token has expired");
      lookup.touch(row.id).catch(() => undefined);
      const agent: AgentIdentity = {
        tokenId: row.id,
        name: row.name,
        userId: row.userId,
        workspaceId: row.workspaceId,
        scopes: row.scopes,
      };
      return {
        token,
        clientId: row.id,
        scopes: row.scopes,
        expiresAt: Math.floor(row.expiresAt.getTime() / 1000),
        extra: { agent },
      };
    },
  };
}

export const agentFromAuth = (auth: AuthInfo | undefined) =>
  (auth?.extra?.agent as AgentIdentity | undefined) ?? null;

// The whole endpoint: Origin check, bearer token, then a fresh server per request.
export function createAgentEndpoint(options: {
  lookup: Parameters<typeof agentTokenVerifier>[0];
  actions: AgentActions;
  audit: AgentServerDeps["audit"];
  allowedOrigins: () => string[];
}) {
  const gate = requireBearerAuth({ verifier: agentTokenVerifier(options.lookup) });
  const handler = createMcpHandler(
    ({ authInfo }) => {
      const agent = agentFromAuth(authInfo);
      if (!agent) throw new Error("MCP request reached the server without an agent");
      return createAgentServer({ agent, actions: options.actions, audit: options.audit });
    },
    { onerror: (error) => console.error("[mcp]", error) },
  );
  return async (request: Request) => {
    const rejected = originValidationResponse(request, options.allowedOrigins());
    if (rejected) return rejected;
    const auth = await gate(request);
    if (auth instanceof Response) return auth;
    return handler.fetch(request, { authInfo: auth });
  };
}
