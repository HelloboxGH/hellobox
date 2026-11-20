import "@/core/extensions";
import { emitEvent, type WorkspaceEventName } from "@hellobox/extensions";
import type { WorkspaceContext } from "./middlewares";

/**
 * Says what just happened in a workspace. Cloud's audit log listens; the open build has no
 * listeners, so this does nothing there. Call it after the change, outside any transaction.
 */
export const emit = (ctx: Pick<WorkspaceContext, "workspace" | "user">, name: WorkspaceEventName, target?: string | null, metadata?: Record<string, unknown>) =>
  emitEvent({ name, workspaceId: ctx.workspace.id, userId: ctx.user.id, target, metadata });
