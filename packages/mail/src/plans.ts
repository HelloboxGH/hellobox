export type Plan = "solo" | "starter" | "team" | "business";

// Not a plan limit: the most one attachment can be, whatever the plan.
export const MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024;
