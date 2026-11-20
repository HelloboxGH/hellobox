import { getExtensions } from "@/core/extensions";
import { suspendedMessage } from "@/core/server/support";
import { getDb, members, user as users, workspaces } from "@hellobox/db";
import { and, eq, sql } from "drizzle-orm";
import { grantErrorProvider, markProviderNeedsReconnect, readableMailboxIds, reconnectMessage, touchWorkspace } from "@hellobox/mail";
import { AppError, createMiddleware, forbidden, unauthorized } from "nezt";
import { RECONNECT_REQUIRED } from "@/core/reconnect";
import { headers } from "next/headers";
import { getAuth } from "@/core/auth";
import { safeAvatarUrl } from "@/core/avatar";
import type { Entitlements } from "@hellobox/extensions";
import { type AgentIdentity, currentAgent } from "./agents/context";
import { entitlements } from "./entitlements";

export interface UserContext {
  user: { id: string; name: string; email: string; image: string | null; isAnonymous?: boolean };
  // Set when an agent is acting for the user over MCP.
  agent?: AgentIdentity | null;
}

export interface WorkspaceContext extends UserContext {
  workspace: typeof workspaces.$inferSelect;
  role: "owner" | "admin" | "member";
  // What the workspace may do. Unlimited when no billing is registered.
  entitlements: Entitlements;
}

async function agentUser(agent: AgentIdentity): Promise<UserContext["user"]> {
  const [row] = await getDb()
    .select({ id: users.id, name: users.name, email: users.email, image: users.image, bannedAt: users.bannedAt })
    .from(users)
    .where(eq(users.id, agent.userId));
  if (!row) throw unauthorized("This agent's account no longer exists");
  if (row.bannedAt) throw unauthorized("This account is suspended");
  return { id: row.id, name: row.name, email: row.email, image: safeAvatarUrl(row.image) };
}

async function currentUser(): Promise<UserContext["user"]> {
  const agent = currentAgent();
  if (agent) return agentUser(agent);
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) throw unauthorized("Please sign in");
  return {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
    image: safeAvatarUrl(session.user.image),
    // A demo visitor. Locked actions are refused in the middlewares below.
    isAnonymous: Boolean(session.user.isAnonymous),
  };
}

export const requireUser = createMiddleware<object, UserContext>(
  async ({ ctx, next }) => {
    const user = await currentUser();
    getExtensions().mail?.guardRequest?.({ request: ctx.request, sandbox: Boolean(user.isAnonymous) });
    return next({
      ctx: ctx.add("user", user).add("agent", currentAgent()) as never,
    });
  },
);

// The workspace comes from a header, or an agent's token, but access always
// comes from the membership row, so a role change applies to agents at once.
async function resolveWorkspace(userId: string) {
  const agent = currentAgent();
  const requested = agent ? agent.workspaceId : (await headers()).get("x-workspace-id");
  const rows = await getDb()
    .select({ workspace: workspaces, role: members.role })
    .from(members)
    .innerJoin(workspaces, eq(workspaces.id, members.workspaceId))
    .where(
      requested
        ? and(eq(members.userId, userId), eq(members.workspaceId, requested))
        : eq(members.userId, userId),
    )
    // Without a choice, a suspended workspace is the last one picked.
    .orderBy(sql`${workspaces.suspendedAt} is not null`, members.createdAt)
    .limit(1);
  const row = rows[0];
  if (!row) throw forbidden("You don't have access to this workspace");
  if (row.workspace.suspendedAt) {
    throw forbidden(suspendedMessage("workspace"));
  }
  // Every app, API and agent call comes through here. Mail arriving doesn't.
  void touchWorkspace(row.workspace.id);
  return row;
}

// A provider grant that expired or was revoked mid-action: the connection is marked so
// the app asks to reconnect, and the person gets that instead of the provider's raw error.
async function withReconnect<T>(workspaceId: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const provider = grantErrorProvider(error);
    if (!provider) throw error;
    await markProviderNeedsReconnect(workspaceId, provider);
    throw new AppError(reconnectMessage(provider), RECONNECT_REQUIRED, 409, { provider });
  }
}

export const requireWorkspace = createMiddleware<object, WorkspaceContext>(
  async ({ ctx, next }) => {
    const user = await currentUser();
    const { workspace, role } = await resolveWorkspace(user.id);
    getExtensions().mail?.guardRequest?.({ request: ctx.request, sandbox: Boolean(user.isAnonymous || workspace.demoExpiresAt) });
    const workspaceEntitlements = await entitlements(workspace.id);
    return withReconnect(workspace.id, () =>
      next({
        ctx: ctx
          .add("user", user)
          .add("agent", currentAgent())
          .add("workspace", workspace)
          .add("role", role)
          .add("entitlements", workspaceEntitlements) as never,
      }),
    );
  },
);

export const requireAdmin = createMiddleware<object, WorkspaceContext>(
  async ({ ctx, next }) => {
    const user = await currentUser();
    const { workspace, role } = await resolveWorkspace(user.id);
    getExtensions().mail?.guardRequest?.({ request: ctx.request, sandbox: Boolean(user.isAnonymous || workspace.demoExpiresAt) });
    const workspaceEntitlements = await entitlements(workspace.id);
    if (role === "member") throw forbidden("Only admins can do this");
    return withReconnect(workspace.id, () =>
      next({
        ctx: ctx
          .add("user", user)
          .add("agent", currentAgent())
          .add("workspace", workspace)
          .add("role", role)
          .add("entitlements", workspaceEntitlements) as never,
      }),
    );
  },
);

// Assigned mailboxes plus personal ones. Admins get no wider view: they read what
// they're given, like everyone else.
export const accessibleMailboxIds = (ctx: WorkspaceContext) => readableMailboxIds(ctx.workspace.id, ctx.user.id);

export async function assertMailboxAccess(ctx: WorkspaceContext, mailboxId: string) {
  const ids = await accessibleMailboxIds(ctx);
  if (!ids.includes(mailboxId)) throw forbidden("You don't have access to this mailbox");
}
