import { type Entitlements, type Extensions, type ResolvedExtensions, UNLIMITED, type WorkspaceEvent } from "./types";

// One copy per process, whatever the bundler does to this module: Turbopack can bundle it
// twice, and a second empty registry would quietly turn billing off.
const KEY = Symbol.for("hellobox.extensions");
type Holder = { [KEY]?: ResolvedExtensions };

/** Fills in the "nothing registered" behavior. Billing stays absent: absent means unlimited. */
export function withDefaults(ext: Extensions): ResolvedExtensions {
  return {
    ...ext,
    events: ext.events ?? [],
    actions: ext.actions ?? {},
    jobs: ext.jobs ?? {},
  };
}

export function install(ext: Extensions): void {
  (globalThis as Holder)[KEY] = withDefaults(ext);
}

/**
 * Reading before install() throws. A cloud build that forgot to install must fail loudly,
 * never fall back to "unlimited".
 */
export function getExtensions(): ResolvedExtensions {
  const ext = (globalThis as Holder)[KEY];
  if (!ext) {
    throw new Error("Extensions not installed: import @/core/extensions (web) or ./extensions (worker) first");
  }
  return ext;
}

/**
 * What a workspace may do. With no billing registered that is everything, which is the
 * open build's behavior; cloud's billing slot answers from the workspace's plan.
 */
export async function entitlementsFor(workspaceId: string): Promise<Entitlements> {
  return (await getExtensions().billing?.entitlements(workspaceId)) ?? UNLIMITED;
}

/**
 * Tells every registered listener what happened. Awaited by the caller after the change, in
 * order, so a listener that throws fails the action as a direct audit write did. With no
 * listeners (the open build) it does nothing.
 */
export async function emitEvent(event: WorkspaceEvent): Promise<void> {
  for (const listen of getExtensions().events) await listen(event);
}

/** For tests. */
export function resetExtensions(): void {
  delete (globalThis as Holder)[KEY];
}

/**
 * The startup check for cloud deploys, which set HELLOBOX_CLOUD=1: a deploy that
 * installed the open stubs (a missing cloud/ folder in the image) would otherwise run
 * with every workspace unlimited and no audit logs. `hasBilling` is whether the installed
 * extensions registered billing, which only cloud does.
 */
export function assertCloudBuild(env: Record<string, string | undefined>, hasBilling: boolean): void {
  if (env.HELLOBOX_CLOUD === "1" && !hasBilling) {
    throw new Error("HELLOBOX_CLOUD=1 but the cloud extensions aren't in this build");
  }
}
