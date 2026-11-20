import type { RuleAction, RuleCondition } from "@hellobox/db";
import { domainOf } from "./threading";

export type Category = "primary" | "notifications" | "purchases" | "newsletters";

const NOTIFICATION_DOMAINS = new Set([
  "github.com", "gitlab.com", "linear.app", "vercel.com", "figma.com",
  "slack.com", "notion.so", "atlassian.net", "sentry.io",
]);
const PURCHASE_DOMAINS = new Set([
  "stripe.com", "paypal.com", "paddle.com", "gumroad.com", "dodopayments.com",
]);
const PURCHASE_WORDS =
  /\b(receipt|invoice|order\s*(#|confirmation|number)|payment (received|confirmation)|your (order|purchase))\b/i;
const STRUCTURED_PURCHASE =
  /schema\.org\/?["',\s]+[^>]{0,200}(Order|ParcelDelivery|Invoice)|"@type"\s*:\s*"(Order|ParcelDelivery|Invoice)"/;

export interface CategorizeInput {
  fromAddress: string;
  subject: string;
  headers: Record<string, string | string[]>;
  html?: string | null;
}

export function categorize(input: CategorizeInput): {
  category: Category;
  reason: string;
} {
  const domain = domainOf(input.fromAddress);
  const baseDomain = domain.split(".").slice(-2).join(".");
  const has = (name: string) => input.headers[name] !== undefined;
  const value = (name: string) => String(input.headers[name] ?? "").toLowerCase();

  if (STRUCTURED_PURCHASE.test(input.html ?? "")) {
    return { category: "purchases", reason: "Structured order data" };
  }
  if (PURCHASE_DOMAINS.has(baseDomain)) {
    return { category: "purchases", reason: "Known purchase sender" };
  }
  if (PURCHASE_WORDS.test(input.subject)) {
    return { category: "purchases", reason: "Purchase wording in subject" };
  }
  if (NOTIFICATION_DOMAINS.has(baseDomain)) {
    return { category: "notifications", reason: "Known notification sender" };
  }
  if (has("list-unsubscribe") || has("list-id") || value("precedence") === "bulk") {
    return { category: "newsletters", reason: "Mailing list headers" };
  }
  if (value("auto-submitted").startsWith("auto-")) {
    return { category: "notifications", reason: "Automated message header" };
  }
  return { category: "primary", reason: "No automated signals" };
}

export function matchesRule(
  conditions: RuleCondition[],
  message: { fromAddress: string; to: string[]; subject: string },
) {
  if (conditions.length === 0) return false;
  return conditions.every((condition) => {
    const expected = condition.value.toLowerCase();
    const values =
      condition.field === "from"
        ? [message.fromAddress]
        : condition.field === "fromDomain"
          ? [domainOf(message.fromAddress)]
          : condition.field === "to"
            ? message.to
            : [message.subject];
    return values.some((value) => {
      const actual = value.toLowerCase();
      return condition.op === "equals"
        ? actual === expected
        : actual.includes(expected);
    });
  });
}

export function applyRules(
  rules: { conditions: RuleCondition[]; action: RuleAction }[],
  message: { fromAddress: string; to: string[]; subject: string },
): RuleAction {
  // Rules arrive in priority order, and the first match wins.
  return rules.find((rule) => matchesRule(rule.conditions, message))?.action ?? {};
}
