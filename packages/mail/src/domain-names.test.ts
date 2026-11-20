import { describe, expect, test } from "bun:test";
import { fitsPlan, groupDomains, isSubdomainOf, overPlan, planDomainCount, rootDomain, subdomainProblem } from "./domain-names";

describe("subdomain detection", () => {
  test("a subdomain ends in a dot and its parent", () => {
    expect(isSubdomainOf("reply.acme.com", "acme.com")).toBe(true);
    expect(isSubdomainOf("a.reply.acme.com", "acme.com")).toBe(true);
    expect(isSubdomainOf("acme.com", "acme.com")).toBe(false);
    expect(isSubdomainOf("notacme.com", "acme.com")).toBe(false);
  });

  test("the root is the highest domain the workspace has", () => {
    const names = ["acme.com", "reply.acme.com", "a.reply.acme.com", "other.io"];
    expect(rootDomain("a.reply.acme.com", names)).toBe("acme.com");
    expect(rootDomain("reply.acme.com", names)).toBe("acme.com");
    expect(rootDomain("other.io", names)).toBe("other.io");
  });

  test("a subdomain without its parent in the workspace stands alone", () => {
    expect(rootDomain("reply.acme.com", ["reply.acme.com", "mg.acme.com"])).toBe("reply.acme.com");
  });

  test("country domains don't group under their suffix", () => {
    expect(rootDomain("acme.co.uk", ["acme.co.uk", "other.co.uk"])).toBe("acme.co.uk");
  });

  test("a receiving subdomain has to sit under the parent", () => {
    expect(subdomainProblem("acme.com", "reply.acme.com")).toBeNull();
    expect(subdomainProblem("acme.com", "acme.com")).toContain("reply.acme.com");
    expect(subdomainProblem("acme.com", "reply.other.com")).toContain("subdomain of acme.com");
  });
});

describe("plan counting", () => {
  test("subdomains count under their parent", () => {
    expect(planDomainCount(["acme.com", "reply.acme.com", "mg.acme.com"])).toBe(1);
    expect(planDomainCount(["acme.com", "reply.acme.com", "other.io"])).toBe(2);
  });

  test("subdomains without their parent count once each", () => {
    expect(planDomainCount(["reply.acme.com", "mg.acme.com"])).toBe(2);
  });

  test("the same domain on two connections counts once", () => {
    expect(planDomainCount(["acme.com", "acme.com"])).toBe(1);
  });

  test("a subdomain fits a full plan when its parent is on", () => {
    expect(fitsPlan(["acme.com", "other.io"], "reply.acme.com", 2)).toBe(true);
    expect(fitsPlan(["acme.com", "other.io"], "third.dev", 2)).toBe(false);
    expect(fitsPlan(["acme.com"], "third.dev", 2)).toBe(true);
  });

  test("a parent fits when it joins subdomains that were counted apart", () => {
    expect(fitsPlan(["reply.acme.com", "mg.acme.com"], "acme.com", 2)).toBe(true);
  });

  test("a subdomain of an on domain stays free over the limit", () => {
    expect(fitsPlan(["acme.com", "b.io", "c.io"], "reply.acme.com", 2)).toBe(true);
  });

  test("a downgrade keeps the oldest places, with their subdomains", () => {
    const rows = [
      { id: "1", name: "acme.com" },
      { id: "2", name: "b.io" },
      { id: "3", name: "reply.acme.com" },
      { id: "4", name: "c.io" },
      { id: "5", name: "reply.c.io" },
    ];
    expect(overPlan(rows, 2)).toEqual(["4", "5"]);
    expect(overPlan(rows, 1)).toEqual(["2", "4", "5"]);
  });
});

describe("groupDomains", () => {
  test("lists subdomains right after their parent", () => {
    const grouped = groupDomains([{ name: "reply.acme.com" }, { name: "b.io" }, { name: "acme.com" }, { name: "mg.acme.com" }]);
    expect(grouped.map((row) => [row.domain.name, row.parent])).toEqual([
      ["acme.com", null],
      ["mg.acme.com", "acme.com"],
      ["reply.acme.com", "acme.com"],
      ["b.io", null],
    ]);
  });
});
