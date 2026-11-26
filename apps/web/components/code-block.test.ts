import { expect, test } from "bun:test";
import { supportCurl, supportNode } from "@/core/support-setup";
import { highlight } from "./code-block";

const kinds = (code: string, language: "js" | "bash") =>
  highlight(code, language).filter((token) => token.kind !== "plain").map((token) => [token.kind, token.text]);

test("nothing is lost or added", () => {
  for (const [code, language] of [[supportNode("https://x.test"), "js"], [supportCurl("https://x.test", "hbs_x"), "bash"]] as const) {
    expect(highlight(code, language).map((token) => token.text).join("")).toBe(code);
  }
});

test("JavaScript: comments, strings, keywords and keys", () => {
  expect(kinds(`// hi\nconst a = await fetch("u", { method: "POST" }); // done`, "js")).toEqual([
    ["comment", "// hi"], ["keyword", "const"], ["keyword", "await"], ["string", `"u"`],
    ["property", "method"], ["string", `"POST"`], ["comment", "// done"],
  ]);
  expect(kinds("x = `Bearer ${key}`", "js")).toEqual([["string", "`Bearer ${key}`"]]);
});

test("shell: the command, flags and quoted strings", () => {
  expect(kinds(`curl https://x.test/a#b \\\n  -H "A: b" \\\n  -d '{"x": 1}'`, "bash")).toEqual([
    ["keyword", "curl"], ["property", "-H"], ["string", `"A: b"`], ["property", "-d"], ["string", `'{"x": 1}'`],
  ]);
});
