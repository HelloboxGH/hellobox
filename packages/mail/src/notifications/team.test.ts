import { describe, expect, test } from "bun:test";
import { assignmentNotices, mentionedIn } from "./team";

describe("assignmentNotices", () => {
  const before = [
    { id: "t1", assignedTo: null },
    { id: "t2", assignedTo: "bob" },
    { id: "t3", assignedTo: "ada" },
  ];

  test("tells the new assignee about each conversation that changes hands", () => {
    expect(assignmentNotices(before, "ada", "bob")).toEqual(["t1", "t2"]);
  });

  test("says nothing about a conversation they already had", () => {
    expect(assignmentNotices([{ id: "t3", assignedTo: "ada" }], "ada", "bob")).toEqual([]);
  });

  test("says nothing when someone takes a conversation themselves", () => {
    expect(assignmentNotices(before, "bob", "bob")).toEqual([]);
  });

  test("says nothing when a conversation is unassigned", () => {
    expect(assignmentNotices(before, null, "bob")).toEqual([]);
  });
});

describe("mentionedIn", () => {
  const people = [
    { id: "ada", name: "Ada Lovelace" },
    { id: "leo", name: "Léo Martin" },
    { id: "bob", name: "Bob" },
  ];

  test("finds teammates written as @Full Name, in any case", () => {
    expect(mentionedIn("@ada lovelace and @Léo Martin, can you look?", people, "bob")).toEqual(["ada", "leo"]);
  });

  test("never mentions the author", () => {
    expect(mentionedIn("@Bob note to self", people, "bob")).toEqual([]);
  });

  test("needs the whole name, not a longer word", () => {
    expect(mentionedIn("@Bobby can you check", people, "ada")).toEqual([]);
    expect(mentionedIn("thanks @Bob.", people, "ada")).toEqual(["bob"]);
  });

  test("ignores names without the @", () => {
    expect(mentionedIn("Ada Lovelace said so", people, "bob")).toEqual([]);
  });
});
