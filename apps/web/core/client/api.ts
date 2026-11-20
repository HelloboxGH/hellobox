import type { ActionMap } from "@/core/server/actions-manifest";

const WORKSPACE_KEY = "hellobox.workspace";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly type?: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

// The workspace this page works in. It's read from storage once and then kept for the
// page's life, because storage is shared by every tab: opening a notification for
// another workspace in a new tab must not quietly point this tab's requests at it while
// it still shows the old workspace's mail. Storage only says where the next page starts.
let pinned: string | null | undefined;

export function getWorkspaceId() {
  if (pinned !== undefined) return pinned;
  try {
    pinned = localStorage.getItem(WORKSPACE_KEY);
  } catch {
    pinned = null;
  }
  return pinned;
}

/** Forget the saved workspace (it's gone from this person's list), so the server picks their first. */
export function clearWorkspaceId() {
  pinned = undefined;
  try {
    localStorage.removeItem(WORKSPACE_KEY);
  } catch {
    // Storage can be blocked, and then there's nothing saved to clear.
  }
}

export function setWorkspaceId(id: string) {
  pinned = id;
  try {
    localStorage.setItem(WORKSPACE_KEY, id);
  } catch {
    // Storage can be blocked. The server then uses the first workspace.
  }
}

type Input<K extends keyof ActionMap> = Parameters<ActionMap[K]>[0];
export type Output<K extends keyof ActionMap> = Awaited<ReturnType<ActionMap[K]>>;

export async function call<K extends keyof ActionMap>(
  path: K,
  ...args: undefined extends Input<K> ? [Input<K>?] : [Input<K>]
): Promise<Output<K>> {
  const workspaceId = getWorkspaceId();
  const res = await fetch(`/api/actions${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(workspaceId ? { "x-workspace-id": workspaceId } : {}),
    },
    body: JSON.stringify(args[0] ?? {}),
  });
  const body = (await res.json().catch(() => null)) as {
    data: Output<K>;
    error: { code: number; message: string; type?: string; details?: unknown } | null;
  } | null;
  if (!res.ok || body?.error || !body) {
    throw new ApiError(res.status, body?.error?.message ?? "Something went wrong", body?.error?.type, body?.error?.details);
  }
  return body.data;
}

export type Bootstrap = Output<"/app/bootstrap">;
export type ThreadSummary = Output<"/threads/list">["threads"][number];
export type ThreadDetail = Output<"/threads/get">;
export type ThreadMessage = ThreadDetail["messages"][number];
export type Draft = Output<"/drafts/list">[number];
export type Scheduled = Output<"/mail/scheduled">[number];
