import { describe, expect, test } from "bun:test";
// @ts-expect-error: plain JavaScript, like the rest of the ESLint config.
import { colorClasses } from "./colors.mjs";

describe("colorClasses", () => {
  test("finds palette colors, with variants and opacity", () => {
    expect(colorClasses("flex text-amber-500 hover:bg-red-50 dark:border-white/10 bg-black/45")).toEqual([
      "text-amber-500",
      "bg-red-50",
      "border-white/10",
      "bg-black/45",
    ]);
  });

  test("finds hex classes, except allowed brand colors", () => {
    expect(colorClasses("bg-[#F38020] text-[#123456] ring-[#f38020]/40", ["#F38020"])).toEqual(["text-[#123456]"]);
  });

  test("leaves theme tokens and other values alone", () => {
    expect(
      colorClasses("bg-brand text-brand-contrast text-star border-border text-[0.625rem] shadow-[0_1px_2px_rgb(0_0_0/0.15)]"),
    ).toEqual([]);
    expect(colorClasses("color:#26262b; background:#fff")).toEqual([]);
    expect(colorClasses("Go to-do list, black text")).toEqual([]);
  });
});
