import { afterEach, describe, expect, test } from "bun:test";
import { install, resetExtensions } from "@hellobox/extensions";
import { hasVerifiedSso, isQuiet, NOTICE_DAYS, QUIET_DAYS, txtRecordFor } from "./takeovers";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-11-18T12:00:00Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * DAY);

describe("isQuiet", () => {
  test("a workspace used within 90 days keeps its domains", () => {
    expect(isQuiet({ lastActiveAt: daysAgo(89), createdAt: daysAgo(400) }, now)).toBe(false);
  });
  test("90 days without use is quiet", () => {
    expect(isQuiet({ lastActiveAt: daysAgo(90), createdAt: daysAgo(400) }, now)).toBe(true);
  });
  test("a workspace never used counts from when it was made", () => {
    expect(isQuiet({ lastActiveAt: null, createdAt: daysAgo(10) }, now)).toBe(false);
    expect(isQuiet({ lastActiveAt: null, createdAt: daysAgo(120) }, now)).toBe(true);
  });
  test("the rules are 90 days quiet and 7 days' notice", () => {
    expect(QUIET_DAYS).toBe(90);
    expect(NOTICE_DAYS).toBe(7);
  });
});

describe("txtRecordFor", () => {
  test("lives under _hellobox, whatever case the domain was typed in", () => {
    expect(txtRecordFor("Acme.com.", "abc")).toEqual({ type: "TXT", name: "_hellobox.acme.com", value: "hellobox-verify=abc" });
  });
});

describe("hasVerifiedSso", () => {
  afterEach(resetExtensions);

  test("with no auth slot a holder is never an SSO holder", async () => {
    install({});
    expect(await hasVerifiedSso("ws1", "Acme.com.")).toBe(false);
  });

  test("asks the slot about the normalized domain", async () => {
    const asked: string[][] = [];
    install({ auth: { ssoOwnsDomain: async (workspaceId, domain) => (asked.push([workspaceId, domain]), true) } });
    expect(await hasVerifiedSso("ws1", "Acme.com.")).toBe(true);
    expect(asked).toEqual([["ws1", "acme.com"]]);
  });
});
