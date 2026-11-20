import { describe, expect, test } from "bun:test";
import { mergeSuggestions } from "./recipients";

const luke = { email: "luke@example.com", firstName: "Luke", lastName: null };

describe("mergeSuggestions", () => {
  test("puts contacts first, then people written to", () => {
    expect(mergeSuggestions([luke], [{ address: "ada@example.com", name: "Ada" }])).toEqual([
      { address: "luke@example.com", name: "Luke", contact: true },
      { address: "ada@example.com", name: "Ada", contact: false },
    ]);
  });

  test("lists an address once, keeping the contact", () => {
    const merged = mergeSuggestions([luke], [{ address: "Luke@Example.com", name: "L. S." }]);
    expect(merged).toEqual([{ address: "luke@example.com", name: "Luke", contact: true }]);
  });

  test("leaves out recipients already added, and stops at the limit", () => {
    const sent = ["a", "b", "c"].map((n) => ({ address: `${n}@example.com`, name: null }));
    expect(mergeSuggestions([luke], sent, ["LUKE@example.com"], 2).map((s) => s.address)).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
  });

  test("treats blank names as no name", () => {
    expect(mergeSuggestions([{ email: "x@example.com", firstName: " ", lastName: "" }], [])[0]?.name).toBeNull();
  });
});
