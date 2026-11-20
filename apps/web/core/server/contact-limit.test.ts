import { beforeEach, describe, expect, test } from "bun:test";
import { install, resetExtensions, UNLIMITED } from "@hellobox/extensions";
import { contactLimitError } from "./contact-limit";

// A stand-in for cloud's billing slot: it only says what was refused.
const slot = {
  entitlements: async () => UNLIMITED,
  denied: (ctx: object, refusal: object) => Object.assign(new Error("refused"), { ctx, refusal }),
};
const ctx = (contacts: number) => ({
  role: "owner",
  entitlements: { ...UNLIMITED, limits: { ...UNLIMITED.limits, contacts } },
});

beforeEach(() => {
  resetExtensions();
  install({ billing: slot });
});

describe("contact limits", () => {
  test("let contacts in up to the limit", () => {
    expect(contactLimitError(ctx(1_000), 999, 1)).toBeNull();
    expect(contactLimitError(ctx(1_000), 0, 1_000)).toBeNull();
    expect(contactLimitError(ctx(Infinity), 10_000_000, 50_000)).toBeNull();
  });

  test("past the limit, the billing slot builds the error", () => {
    const error = contactLimitError(ctx(1_000), 995, 10) as unknown as { refusal: Record<string, unknown> };
    expect(error.refusal).toEqual({
      limit: "contacts",
      current: 995,
      max: 1_000,
      needed: 1_005,
      message: "Your plan stores up to 1,000 contacts, so only 5 more fit",
    });
    expect((contactLimitError(ctx(1_000), 1_000, 1) as unknown as { refusal: { message: string } }).refusal.message).toBe(
      "Your plan stores up to 1,000 contacts",
    );
  });

  test("without a billing slot nothing is refused", () => {
    resetExtensions();
    install({});
    expect(contactLimitError({ role: "owner", entitlements: UNLIMITED }, 5_000_000, 1)).toBeNull();
  });
});
