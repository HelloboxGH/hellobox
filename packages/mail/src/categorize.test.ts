import { describe, expect, it } from "bun:test";
import { applyRules, categorize } from "./categorize";

const base = { fromAddress: "ada@example.com", subject: "Hello", headers: {} };

describe("categorize", () => {
  it("defaults to primary", () => {
    expect(categorize(base).category).toBe("primary");
  });
  it("detects purchases from wording", () => {
    expect(categorize({ ...base, subject: "Your receipt" }).category).toBe("purchases");
  });
  it("detects newsletters from headers", () => {
    expect(
      categorize({ ...base, headers: { "list-unsubscribe": "<x>" } }).category,
    ).toBe("newsletters");
  });
  it("detects known notification senders on subdomains", () => {
    expect(
      categorize({ ...base, fromAddress: "noreply@mail.github.com" }).category,
    ).toBe("notifications");
  });
  it("ignores lookalike domains", () => {
    expect(
      categorize({ ...base, fromAddress: "x@github.com.evil.io" }).category,
    ).toBe("primary");
  });
});

describe("applyRules", () => {
  it("uses the first matching rule", () => {
    const result = applyRules(
      [
        {
          conditions: [{ field: "fromDomain", op: "equals", value: "stripe.com" }],
          action: { category: "purchases" },
        },
        {
          conditions: [{ field: "subject", op: "contains", value: "hi" }],
          action: { folder: "archive" },
        },
      ],
      { fromAddress: "a@stripe.com", to: [], subject: "hi" },
    );
    expect(result).toEqual({ category: "purchases" });
  });
});
