import { describe, expect, test } from "bun:test";
import Redis from "ioredis";
import { BOUNCE_LIMITS, bounceBuckets, bounceDecision, bounceMessage, claimBounce } from "./bounce";

const base = {
  from: "Ada <ada@example.com>",
  headers: {},
  authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
  looksLikeSpam: false,
  sendingEnabled: true,
};

describe("bounceDecision", () => {
  test("bounces authenticated mail from a person", () => {
    expect(bounceDecision(base)).toEqual({ send: true, to: "ada@example.com" });
  });

  test("answers the authenticated From, never a Return-Path that could name someone else", () => {
    expect(bounceDecision({ ...base, headers: { "return-path": "<victim@elsewhere.test>" } })).toEqual({ send: true, to: "ada@example.com" });
  });

  test("never bounces to a sender that could be forged", () => {
    expect(bounceDecision({ ...base, authentication: { spf: "pass", dkim: "fail", dmarc: "fail" } }).send).toBe(false);
    expect(bounceDecision({ ...base, authentication: null }).send).toBe(false);
  });

  test("never answers spam, automated mail or a bounce", () => {
    expect(bounceDecision({ ...base, looksLikeSpam: true }).send).toBe(false);
    expect(bounceDecision({ ...base, headers: { "auto-submitted": "auto-replied" } }).send).toBe(false);
    expect(bounceDecision({ ...base, headers: { precedence: "bulk" } }).send).toBe(false);
    expect(bounceDecision({ ...base, headers: { "list-unsubscribe": "<mailto:x@example.com>" } }).send).toBe(false);
    expect(bounceDecision({ ...base, headers: { "return-path": "<>" } }).send).toBe(false);
    expect(bounceDecision({ ...base, from: "noreply@example.com" }).send).toBe(false);
    expect(bounceDecision({ ...base, from: "MAILER-DAEMON@example.com" }).send).toBe(false);
  });

  test("only bounces when the domain can send", () => {
    expect(bounceDecision({ ...base, sendingEnabled: false }).send).toBe(false);
  });
});

test("the bounce says which address doesn't exist and is marked automatic", () => {
  const message = bounceMessage({ recipient: "typo@acme.test", subject: "Hello", sentAt: new Date(0), messageId: "<1@example.com>" });
  expect(message.subject).toBe("Undeliverable: Hello");
  expect(message.text).toContain("typo@acme.test");
  expect(message.headers["Auto-Submitted"]).toBe("auto-replied");
  expect(message.headers["In-Reply-To"]).toBe("<1@example.com>");
});

describe("bounceBuckets", () => {
  test("caps the sender, its domain, our domain and the workspace", () => {
    const keys = bounceBuckets({ to: "ada@attacker.test", domainId: "d1", workspaceId: "w1" }).map((b) => b.key.split(":")[1]);
    expect(keys).toEqual(["sender", "sender-domain", "domain", "workspace"]);
  });

  test("doesn't cap a shared provider as one domain", () => {
    const keys = bounceBuckets({ to: "ada@gmail.com", domainId: "d1", workspaceId: "w1" }).map((b) => b.key.split(":")[1]);
    expect(keys).not.toContain("sender-domain");
  });

  test("doesn't keep sender addresses readable", () => {
    expect(bounceBuckets({ to: "ada@attacker.test", domainId: "d1", workspaceId: "w1" }).join(" ")).not.toContain("attacker");
  });
});

test("fails closed when the limits can't be checked", async () => {
  const broken = { eval: async () => { throw new Error("down"); } } as unknown as Redis;
  expect(await claimBounce(bounceBuckets({ to: "a@b.test", domainId: "d", workspaceId: "w" }), broken)).toBe("unavailable");
});

// Needs a Redis at REDIS_URL, so it's skipped when there isn't one.
const redisUrl = process.env.REDIS_URL;
describe.skipIf(!redisUrl)("claimBounce against Redis", () => {
  test("stops a sender rotating addresses, and a refusal doesn't use up a slot", async () => {
    const client = new Redis(redisUrl as string);
    const run = crypto.randomUUID();
    const claim = (n: number, domainId = `d-${run}`) =>
      claimBounce(bounceBuckets({ to: `a${n}@${run}.test`, domainId, workspaceId: `w-${run}` }), client);
    const results = [];
    for (let n = 0; n < 5; n += 1) results.push(await claim(n));
    expect(results.filter((r) => r === null)).toHaveLength(BOUNCE_LIMITS.senderDomain.max);
    expect(results.at(-1)).toContain("bounce:sender-domain:");
    expect(await client.get(`bounce:workspace:w-${run}`)).toBe(String(BOUNCE_LIMITS.senderDomain.max));
    expect(await claim(0)).toContain("bounce:sender:");
    await client.quit();
  });
});
