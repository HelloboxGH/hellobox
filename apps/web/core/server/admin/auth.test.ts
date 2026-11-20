import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  adminEmails,
  bearerToken,
  confirmationCode,
  generateAdminToken,
  generateAuthCode,
  isAdminEmail,
  looksLikeAdminToken,
  loopbackCallback,
  pkceMatches,
  sha256,
} from "./auth";

const challengeFor = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

describe("the admin allowlist", () => {
  test("matches emails without regard to case or spacing", () => {
    const allowlist = adminEmails(" Ops@example.com , me@example.com,, ");
    expect([...allowlist]).toEqual(["ops@example.com", "me@example.com"]);
    expect(isAdminEmail("OPS@example.com", allowlist)).toBe(true);
    expect(isAdminEmail("someone@example.com", allowlist)).toBe(false);
  });

  test("is empty when unset, so nobody is an admin", () => {
    expect(adminEmails(undefined).size).toBe(0);
    expect(adminEmails("").size).toBe(0);
    expect(isAdminEmail("ops@example.com", adminEmails(""))).toBe(false);
  });

  test("doesn't treat a lookalike as an admin", () => {
    const allowlist = adminEmails("ops@example.com");
    expect(isAdminEmail("ops@example.com.evil.com", allowlist)).toBe(false);
    expect(isAdminEmail("xops@example.com", allowlist)).toBe(false);
  });
});

describe("PKCE", () => {
  test("accepts the verifier the challenge was made from", () => {
    expect(pkceMatches(VERIFIER, challengeFor(VERIFIER))).toBe(true);
  });

  test("matches RFC 7636's example", () => {
    expect(challengeFor(VERIFIER)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  test("refuses any other verifier", () => {
    expect(pkceMatches(`${VERIFIER.slice(0, -1)}A`, challengeFor(VERIFIER))).toBe(false);
    expect(pkceMatches("short", challengeFor("short"))).toBe(false);
    expect(pkceMatches(VERIFIER, "not-a-challenge")).toBe(false);
  });
});

describe("the sign-in callback", () => {
  test("only ever points at this computer", () => {
    const url = new URL(loopbackCallback(53_682, "code123", "state_abcdefghijkl"));
    expect(url.origin).toBe("http://127.0.0.1:53682");
    expect(url.pathname).toBe("/callback");
    expect(url.searchParams.get("code")).toBe("code123");
    expect(url.searchParams.get("state")).toBe("state_abcdefghijkl");
  });

  test("refuses odd ports and states", () => {
    expect(() => loopbackCallback(80, "c", "state_abcdefghijkl")).toThrow();
    expect(() => loopbackCallback(70_000, "c", "state_abcdefghijkl")).toThrow();
    expect(() => loopbackCallback(53_682, "c", "short")).toThrow();
    expect(() => loopbackCallback(53_682, "c", "state@evil.com/x?y=zzzzzzz")).toThrow();
  });
});

describe("tokens", () => {
  test("are random, prefixed and stored as a hash", () => {
    const first = generateAdminToken();
    expect(looksLikeAdminToken(first.token)).toBe(true);
    expect(first.token).not.toBe(generateAdminToken().token);
    expect(first.hash).toBe(sha256(first.token));
    expect(looksLikeAdminToken("rbx_agent_abc")).toBe(false);
    const code = generateAuthCode();
    expect(code.hash).toBe(sha256(code.code));
  });

  test("come from a Bearer header only", () => {
    expect(bearerToken("Bearer rbx_admin_x")).toBe("rbx_admin_x");
    expect(bearerToken("bearer   rbx_admin_x")).toBe("rbx_admin_x");
    expect(bearerToken("Basic abc")).toBeNull();
    expect(bearerToken(null)).toBeNull();
  });

  test("confirmation codes are short and stable", () => {
    const code = confirmationCode(challengeFor(VERIFIER));
    expect(code).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(confirmationCode(challengeFor(VERIFIER))).toBe(code);
  });
});
