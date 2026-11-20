import { describe, expect, test } from "bun:test";
import { claimConflict, claimConflictMessage, domainKey, notifiesFor, receivesMail } from "./domains";

describe("notifiesFor", () => {
  test("domains that are on notify", () => {
    expect(notifiesFor({ enabled: true, removedAt: null })).toBe(true);
  });
  test("switched-off domains stay quiet", () => {
    expect(notifiesFor({ enabled: false, removedAt: null })).toBe(false);
  });
  test("removed domains stay quiet, even though their mail is still readable", () => {
    expect(notifiesFor({ enabled: false, removedAt: new Date() })).toBe(false);
    expect(notifiesFor({ enabled: true, removedAt: new Date() })).toBe(false);
  });
});

describe("domainKey", () => {
  test("ignores case, spaces and a trailing dot", () => {
    expect(domainKey(" Acme.COM. ")).toBe("acme.com");
  });
});

describe("claimConflict", () => {
  const self = { domainId: "d1", workspaceId: "w1" };
  test("free when no one has it on", () => {
    expect(claimConflict([], self)).toBeNull();
  });
  test("its own claim doesn't count", () => {
    expect(claimConflict([{ domainId: "d1", workspaceId: "w1" }], self)).toBeNull();
  });
  test("another connection in the same workspace", () => {
    expect(claimConflict([{ domainId: "d2", workspaceId: "w1" }], self)).toBe("this-workspace");
  });
  test("another workspace", () => {
    expect(claimConflict([{ domainId: "d3", workspaceId: "w2" }], self)).toBe("other-workspace");
  });
  test("a new domain, not saved yet, is blocked by any claim", () => {
    expect(claimConflict([{ domainId: "d3", workspaceId: "w2" }], { workspaceId: "w1" })).toBe("other-workspace");
  });
  test("the same workspace is reported first, since it's the one they can fix", () => {
    expect(
      claimConflict([{ domainId: "d3", workspaceId: "w2" }, { domainId: "d2", workspaceId: "w1" }], self),
    ).toBe("this-workspace");
  });
});

describe("claimConflictMessage", () => {
  test("says nothing about another workspace until their provider has verified the domain", () => {
    const message = claimConflictMessage("acme.com", "other-workspace", false);
    expect(message).not.toContain("workspace");
    expect(message).toContain("Verify");
  });
  test("once verified, says another workspace has it without naming it", () => {
    expect(claimConflictMessage("acme.com", "other-workspace", true)).toBe(
      "acme.com is already in use in another HelloBox workspace",
    );
  });
  test("a clash in the same workspace says where to fix it", () => {
    expect(claimConflictMessage("acme.com", "this-workspace", false)).toContain("Remove it there first");
  });
});

describe("receivesMail", () => {
  const at = (day: number) => new Date(Date.UTC(2026, 0, day));
  const copy = (domainId: string, workspaceId: string, enabled: boolean, status: string | null, day: number) =>
    ({ domainId, workspaceId, enabled, status, createdAt: at(day) });
  const self = (id: string, workspaceId: string, removedAt: Date | null = null) => ({ id, workspaceId, removedAt });

  test("a removed domain never takes new mail", () => {
    expect(receivesMail(self("a", "w1", new Date()), [copy("a", "w1", true, "verified", 1)])).toBe(false);
  });
  test("the only copy takes it, on or off (off keeps it hidden for a plan downgrade)", () => {
    expect(receivesMail(self("a", "w1"), [copy("a", "w1", true, "verified", 1)])).toBe(true);
    expect(receivesMail(self("a", "w1"), [copy("a", "w1", false, "verified", 1)])).toBe(true);
  });
  test("a switched-off copy gets nothing while another workspace has the domain on", () => {
    const copies = [copy("mine", "w1", false, "verified", 1), copy("theirs", "w2", true, "verified", 5)];
    expect(receivesMail(self("mine", "w1"), copies)).toBe(false);
    expect(receivesMail(self("theirs", "w2"), copies)).toBe(true);
  });
  test("an unverified copy that's on loses to a verified one, even an older off one", () => {
    const copies = [copy("squat", "w1", true, "pending", 1), copy("owner", "w2", false, "verified", 5)];
    expect(receivesMail(self("squat", "w1"), copies)).toBe(false);
    expect(receivesMail(self("owner", "w2"), copies)).toBe(true);
  });
  test("two workspaces both on from before the one-place rule: only the earliest takes it", () => {
    const copies = [copy("new", "w2", true, "verified", 9), copy("old", "w1", true, "verified", 2)];
    expect(receivesMail(self("old", "w1"), copies)).toBe(true);
    expect(receivesMail(self("new", "w2"), copies)).toBe(false);
  });
  test("inside the winning workspace every copy takes it: one provider may send, another receive", () => {
    const copies = [copy("sending", "w1", true, "verified", 1), copy("receiving", "w1", true, "verified", 3)];
    expect(receivesMail(self("receiving", "w1"), copies)).toBe(true);
  });
  test("exactly one workspace takes it, whatever the mix", () => {
    const copies = [
      copy("a", "w1", false, "pending", 1),
      copy("b", "w2", true, "pending", 2),
      copy("c", "w3", false, "verified", 3),
      copy("d", "w4", true, "verified", 4),
      copy("e", "w5", true, "verified", 5),
    ];
    const takers = copies.filter((c) => receivesMail(self(c.domainId, c.workspaceId), copies)).map((c) => c.workspaceId);
    expect(takers).toEqual(["w4"]);
  });
});
