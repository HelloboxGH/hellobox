import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineSettings, SETTINGS } from "./index";

// Only the hosted deploy sets this; self-hosters never need it.
const NOT_FOR_SELF_HOSTERS = new Set(["HELLOBOX_CLOUD"]);

describe("SETTINGS", () => {
  test("every setting is documented in .env.example", () => {
    const example = readFileSync(join(import.meta.dir, "..", "..", "..", ".env.example"), "utf8");
    const documented = new Set([...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
    const missing = SETTINGS.filter((name) => !documented.has(name) && !NOT_FOR_SELF_HOSTERS.has(name));
    expect(missing).toEqual([]);
  });
});

describe("defineSettings", () => {
  const read = defineSettings(["HELLOBOX_TEST_SETTING"]);
  afterEach(() => {
    delete process.env.HELLOBOX_TEST_SETTING;
  });

  test("reads the current value, every time", () => {
    process.env.HELLOBOX_TEST_SETTING = "one";
    expect(read("HELLOBOX_TEST_SETTING")).toBe("one");
    process.env.HELLOBOX_TEST_SETTING = "two";
    expect(read("HELLOBOX_TEST_SETTING")).toBe("two");
  });

  test("an empty value counts as unset", () => {
    process.env.HELLOBOX_TEST_SETTING = "";
    expect(read("HELLOBOX_TEST_SETTING")).toBeUndefined();
  });

  test("refuses a name that isn't in its list", () => {
    expect(() => (read as (name: string) => string | undefined)("SOMETHING_ELSE")).toThrow("isn't a known setting");
  });
});
