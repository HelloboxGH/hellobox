import { describe, expect, test } from "bun:test";
import { sendBlockedReason } from "./mailboxes";

describe("sendBlockedReason", () => {
  test("lets a live mailbox on a live domain send", () => {
    expect(sendBlockedReason({ removedAt: null }, { removedAt: null })).toBeNull();
  });

  test("stops a deleted mailbox, saying how to bring it back", () => {
    expect(sendBlockedReason({ removedAt: new Date() }, { removedAt: null })).toContain("Add it again in settings");
  });

  test("stops a mailbox whose domain was removed", () => {
    expect(sendBlockedReason({ removedAt: null }, { removedAt: new Date() })).toContain("domain was removed");
  });
});

test("the unknown-recipients mailbox never sends", () => {
  expect(sendBlockedReason({ removedAt: null, isCatchAll: true }, { removedAt: null })).toContain("no mailbox");
});

test("a mailbox made by an import, with no domain, can't send", () => {
  expect(sendBlockedReason({ removedAt: null }, null)).toContain("imported mail");
});
