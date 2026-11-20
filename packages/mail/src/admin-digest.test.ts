import { describe, expect, test } from "bun:test";
import { parseAdminEmails } from "@hellobox/config";
import { signupMethod } from "./admin-digest";

describe("signup digest", () => {
  test("names how people signed up", () => {
    expect(signupMethod(["credential"])).toBe("Email");
    expect(signupMethod(["google", "credential"])).toBe("Google, Email");
    expect(signupMethod(["acme-okta"])).toBe("SSO");
    expect(signupMethod([])).toBe("Email");
  });

  test("reads admin emails once each, lowercased", () => {
    expect(parseAdminEmails(" Ada@Example.com, ,ada@example.com,lin@acme.com ")).toEqual(["ada@example.com", "lin@acme.com"]);
    expect(parseAdminEmails("")).toEqual([]);
  });
});
