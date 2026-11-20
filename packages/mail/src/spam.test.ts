import { describe, expect, test } from "bun:test";
import { classifySpam, SPAM_REASONS, senderPolicy } from "./spam";

const unscanned = { raw: null, attachmentNames: [] };

describe("senderPolicy", () => {
  test("matches a blocked address or its whole domain", () => {
    expect(senderPolicy("eve@spam.test", [{ kind: "blocked", value: "eve@spam.test" }])).toEqual({ blocked: true, allowed: false });
    expect(senderPolicy("bob@spam.test", [{ kind: "blocked", value: "spam.test" }]).blocked).toBe(true);
    expect(senderPolicy("ada@example.com", [{ kind: "blocked", value: "eve@spam.test" }]).blocked).toBe(false);
  });

  test("ignores entries that don't block or allow", () => {
    expect(senderPolicy("eve@spam.test", [{ kind: "images_allowed", value: "eve@spam.test" }])).toEqual({ blocked: false, allowed: false });
  });
});

describe("classifySpam", () => {
  test("sends a blocked sender's mail to Spam and says why", async () => {
    const verdict = await classifySpam({ ...unscanned, policy: { blocked: true, allowed: false } });
    expect(verdict.isSpam).toBe(true);
    expect(verdict.reasons).toContain("Sender blocked");
  });

  test("delivers mail from everyone else", async () => {
    const verdict = await classifySpam({ ...unscanned, policy: { blocked: false, allowed: false } });
    expect(verdict.isSpam).toBe(false);
  });
});

describe("classifySpam signals", () => {
  const open = { blocked: false, allowed: false };

  test("keeps mail to an unknown address in Spam, even from an allowed sender", async () => {
    const verdict = await classifySpam({ ...unscanned, policy: { blocked: false, allowed: true }, unknownRecipient: true, exempt: true });
    expect(verdict.isSpam).toBe(true);
    expect(verdict.reasons).toEqual([SPAM_REASONS.unknownRecipient]);
  });

  test("sends a sender many people reported to Spam", async () => {
    const verdict = await classifySpam({ ...unscanned, policy: open, reported: true });
    expect(verdict.isSpam).toBe(true);
    expect(verdict.reasons).toContain(SPAM_REASONS.reported);
  });

  test("a never-spam rule beats reports, but not a workspace block", async () => {
    expect((await classifySpam({ ...unscanned, policy: open, reported: true, exempt: true })).isSpam).toBe(false);
    expect((await classifySpam({ ...unscanned, policy: { blocked: true, allowed: false }, exempt: true })).isSpam).toBe(true);
  });
});
