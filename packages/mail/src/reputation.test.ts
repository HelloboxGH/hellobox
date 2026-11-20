import { describe, expect, test } from "bun:test";
import { hashReputationKey, isReportedSender, normalizeExemptDomain, reputationKey, SPAM_REPORT_THRESHOLD } from "./reputation";

describe("reputationKey", () => {
  test("scores a company by its domain", () => {
    expect(reputationKey("News@Mail.Example.com")).toBe("mail.example.com");
  });

  test("scores someone on a shared provider by their own address", () => {
    expect(reputationKey("Eve@Gmail.com")).toBe("eve@gmail.com");
  });

  test("ignores something that isn't an address", () => {
    expect(reputationKey("not-an-address")).toBeNull();
  });

  test("hashes so domains aren't stored readable", () => {
    expect(hashReputationKey("example.com")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashReputationKey("example.com")).not.toContain("example");
  });
});

test("a sender becomes spam at the threshold", () => {
  expect(isReportedSender(SPAM_REPORT_THRESHOLD - 1)).toBe(false);
  expect(isReportedSender(SPAM_REPORT_THRESHOLD)).toBe(true);
});

describe("normalizeExemptDomain", () => {
  test("accepts the ways people type a domain", () => {
    expect(normalizeExemptDomain(" Example.COM ")).toBe("example.com");
    expect(normalizeExemptDomain("@example.com")).toBe("example.com");
    expect(normalizeExemptDomain("news@mail.example.com")).toBe("mail.example.com");
    expect(normalizeExemptDomain("https://example.com/path")).toBe("example.com");
  });

  test("refuses what isn't a domain", () => {
    expect(normalizeExemptDomain("localhost")).toBeNull();
    expect(normalizeExemptDomain("exa mple.com")).toBeNull();
    expect(normalizeExemptDomain("")).toBeNull();
  });
});
