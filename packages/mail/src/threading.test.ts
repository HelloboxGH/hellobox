import { describe, expect, it } from "bun:test";
import {
  makeSnippet,
  matchesByFallback,
  normalizeSubject,
  parseAddress,
  parseMessageIds,
  threadLookupIds,
} from "./threading";

describe("normalizeSubject", () => {
  it("strips stacked reply and forward prefixes", () => {
    expect(normalizeSubject("Re: FW: re[2]:  Hello   World")).toBe("hello world");
  });
  it("keeps subjects that only look similar", () => {
    expect(normalizeSubject("Regarding: the plan")).toBe("regarding: the plan");
  });
});

describe("parseMessageIds", () => {
  it("handles folded references", () => {
    expect(parseMessageIds("<a@x>\n <b@y>")).toEqual(["<a@x>", "<b@y>"]);
  });
  it("handles missing values", () => {
    expect(parseMessageIds(undefined)).toEqual([]);
  });
});

describe("parseAddress", () => {
  it("parses a display name", () => {
    expect(parseAddress('"Ada L" <ADA@Example.com>')).toEqual({
      address: "ada@example.com",
      name: "Ada L",
    });
  });
  it("parses a bare address", () => {
    expect(parseAddress("ada@example.com")).toEqual({
      address: "ada@example.com",
    });
  });
});

describe("threadLookupIds", () => {
  it("prefers the closest ancestor and removes duplicates", () => {
    expect(threadLookupIds("<c@x>", ["<a@x>", "<b@x>", "<c@x>"])).toEqual([
      "<c@x>",
      "<b@x>",
      "<a@x>",
    ]);
  });
});

describe("matchesByFallback", () => {
  const thread = {
    normalizedSubject: "invoice",
    participants: [{ address: "a@x.com" }],
    lastMessageAt: new Date("2026-01-10"),
  };
  it("matches a reply from a known participant", () => {
    expect(
      matchesByFallback(
        { subject: "Re: Invoice", participants: ["a@x.com"], sentAt: new Date("2026-01-11") },
        thread,
      ),
    ).toBe(true);
  });
  it("does not merge a new email that shares a subject", () => {
    expect(
      matchesByFallback(
        { subject: "Invoice", participants: ["a@x.com"], sentAt: new Date("2026-01-11") },
        thread,
      ),
    ).toBe(false);
  });
  it("does not merge strangers", () => {
    expect(
      matchesByFallback(
        { subject: "Re: Invoice", participants: ["z@x.com"], sentAt: new Date("2026-01-11") },
        thread,
      ),
    ).toBe(false);
  });
  it("does not merge across a long gap", () => {
    expect(
      matchesByFallback(
        { subject: "Re: Invoice", participants: ["a@x.com"], sentAt: new Date("2026-06-11") },
        thread,
      ),
    ).toBe(false);
  });
});

describe("makeSnippet", () => {
  it("removes style blocks and tags from html", () => {
    expect(makeSnippet(null, "<style>a{}</style><p>Hi&nbsp;there</p>")).toBe("Hi there");
  });
  it("drops quoted lines", () => {
    expect(makeSnippet("Thanks\n> old text")).toBe("Thanks");
  });
});
