// The error codes and details type shared by the server, which throws them, and the client,
// which reacts to them. Only plain data: cloud's billing code adds the rest. Stays in core
// because agents/tools.ts reads it.
export type PaidPlanId = "starter" | "team" | "business";
export type IntervalId = "monthly" | "yearly";

export type BillingErrorCode =
  | "PLAN_REQUIRED"
  | "LIMIT_REACHED"
  | "BILLING_MANAGE_REQUIRED"
  | "BILLING_INACTIVE"
  | "ALREADY_SUBSCRIBED"
  | "NO_SUBSCRIPTION"
  | "DOWNGRADE_BLOCKED"
  | "PLAN_CHANGE_FAILED"
  | "CHECKOUT_UNVERIFIED"
  | "BILLING_UNAVAILABLE";

export interface BillingErrorDetails {
  requiredPlan?: PaidPlanId;
  featureName?: string;
  resource?: string;
  current?: number;
  limit?: number;
}

export const BILLING_PATH = "/settings?tab=billing";
