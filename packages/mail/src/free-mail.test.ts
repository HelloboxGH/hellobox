import { describe, expect, it } from "bun:test";
import { isCommonMailDomain, parseBlockTarget } from "./free-mail";

describe("isCommonMailDomain", () => {
  it("knows the usual personal mail providers", () => {
    for (const domain of ["gmail.com", "Outlook.com", "@yahoo.com", "proton.me", "icloud.com"]) expect(isCommonMailDomain(domain)).toBe(true);
    expect(isCommonMailDomain("acme.example")).toBe(false);
  });
});

describe("parseBlockTarget", () => {
  it("accepts an address or a domain, lowercased", () => {
    expect(parseBlockTarget(" Spam@Bad.Example ")).toEqual({ value: "spam@bad.example", kind: "address" });
    expect(parseBlockTarget("@Bad.Example")).toEqual({ value: "bad.example", kind: "domain" });
    expect(parseBlockTarget("not a domain")).toBeNull();
    expect(parseBlockTarget("localhost")).toBeNull();
  });
});
