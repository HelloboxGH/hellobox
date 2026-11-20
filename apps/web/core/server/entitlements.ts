import { type Entitlements, entitlementsFor, type Feature, getExtensions, type Limit, type Refusal, UNLIMITED } from "@hellobox/extensions";
import { badRequest } from "nezt";

// Installed by @/core/extensions, which the action builder imports; a route that uses this
// without the builder imports it itself.
// What a workspace may do. Open builds register no billing, so everything is allowed and
// none of the checks below ever refuse. Cloud's billing slot answers from the plan.
export const entitlements = (workspaceId: string): Promise<Entitlements> => entitlementsFor(workspaceId);

interface Checked {
  role: string;
  entitlements: Entitlements;
}

// The error for a refused check. The billing slot builds the typed one the upgrade dialog
// reacts to; without a slot nothing should be refused, and a plain error is the fallback.
function refusal(ctx: Checked, why: Refusal) {
  return getExtensions().billing?.denied(ctx, why) ?? badRequest(why.message);
}

export function requireFeature(ctx: Checked, feature: Feature, featureName: string, message: string) {
  if (ctx.entitlements.features[feature]) return;
  throw refusal(ctx, { feature, featureName, message });
}

/** The error to throw when `needed` (one more, by default) of a limit doesn't fit. */
export function roomError(ctx: Checked, limit: Limit, current: number, message: string, needed = current + 1) {
  return refusal(ctx, { limit, current, max: ctx.entitlements.limits[limit], needed, message });
}

export function requireRoom(ctx: Checked, limit: Limit, current: number, message: string, needed = current + 1) {
  if (needed <= ctx.entitlements.limits[limit]) return;
  throw roomError(ctx, limit, current, message, needed);
}

/** Entitlements as the app's bootstrap sends them: JSON has no Infinity, so no limit is null. */
export type ClientEntitlements = Omit<Entitlements, "limits"> & { limits: Record<Limit, number | null> };

export function clientEntitlements(value: Entitlements): ClientEntitlements {
  const limits = Object.fromEntries(
    Object.entries(value.limits).map(([limit, max]) => [limit, Number.isFinite(max) ? max : null]),
  ) as ClientEntitlements["limits"];
  return { ...value, limits };
}

/** A member who can't join a full workspace is told to ask whoever manages the plan. */
export function fullWorkspaceError(message: string) {
  return refusal({ role: "member", entitlements: UNLIMITED }, { verbatim: true, message });
}
