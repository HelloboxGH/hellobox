import type { DeliveryRecipients } from "@hellobox/db";

// What a provider's delivery event says, in the inbox's own terms. Recipients are the
// addresses it concerns; an empty list means the provider didn't say which.
export interface DeliveryDetail {
  type: string;
  recipients: string[];
  reason?: string;
}

const STATUS: Record<string, string> = {
  "email.delivered": "delivered",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.failed": "failed",
  "email.delivery_delayed": "delayed",
};

export const deliveryStatusFor = (type: string) => STATUS[type] ?? null;

// Only a permanent bounce or a complaint stops future mail. A delay or a temporary bounce
// says nothing about the address, and a rejected send is our side's problem.
export function suppressionReason(type: string): "bounce" | "complaint" | null {
  if (type === "email.bounced") return "bounce";
  if (type === "email.complained") return "complaint";
  return null;
}

// A later event never hides a worse one for the same recipient: a delay after delivery
// stays delivered, and a complaint replaces delivered.
const RANK: Record<string, number> = { delayed: 1, delivered: 2, failed: 3, bounced: 3, complained: 4 };

export const ANY_RECIPIENT = "*";

export function mergeDelivery(
  current: DeliveryRecipients,
  status: string,
  recipients: string[],
  reason: string | undefined,
  at: Date,
): DeliveryRecipients {
  const next = { ...current };
  const keys = recipients.length ? recipients.map((value) => value.trim().toLowerCase()) : [ANY_RECIPIENT];
  for (const key of keys) {
    const existing = next[key];
    if (existing && (RANK[existing.status] ?? 0) > (RANK[status] ?? 0)) continue;
    next[key] = { status, ...(reason ? { reason } : {}), at: at.toISOString() };
  }
  return next;
}

// The one status a list shows: the most serious problem, then a delay, then delivered.
const SEVERITY = ["complained", "bounced", "failed", "delayed", "delivered"];

export function summarizeDelivery(recipients: DeliveryRecipients): string | null {
  const statuses = new Set(Object.values(recipients).map((entry) => entry.status));
  return SEVERITY.find((status) => statuses.has(status)) ?? null;
}

// One line on why an address is suppressed, for the composer and errors.
export function suppressionWhy(row: { email: string; reason: "bounce" | "complaint"; detail: string | null; createdAt: Date }) {
  const when = row.createdAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  const what = row.reason === "bounce" ? `bounced permanently on ${when}` : `was reported as spam on ${when}`;
  const detail = row.detail?.replace(/\s+/g, " ").trim();
  return `${row.email} ${what}${detail ? ` (${detail.length > 140 ? `${detail.slice(0, 140)}…` : detail})` : ""}`;
}

const bare = (value: string) => (value.match(/<([^>]+)>/)?.[1] ?? value).trim().toLowerCase();

// Resend's webhook names every recipient of the email, not the one that bounced. With
// one recipient that's the same thing; with several, nobody is suppressed on a guess.
export function resendDeliveryDetail(event: { type: string; data: Record<string, unknown> }): DeliveryDetail {
  const to = Array.isArray(event.data.to) ? event.data.to.filter((value): value is string => typeof value === "string") : [];
  const bounce = (event.data.bounce ?? {}) as { type?: string; message?: string; subType?: string };
  const type = event.type === "email.bounced" && bounce.type && bounce.type !== "Permanent" ? "email.delivery_delayed" : event.type;
  return {
    type,
    recipients: to.length === 1 ? [bare(to[0]!)] : [],
    reason: bounce.message || bounce.subType || undefined,
  };
}
