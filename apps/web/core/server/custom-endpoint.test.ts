import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { guardedLookup, isBlockedAddress, normalizeBaseUrl, postToCustomEndpoint } from "./custom-endpoint";

const env = process.env as Record<string, string | undefined>;
const originalEnv = env.NODE_ENV;

describe("isBlockedAddress", () => {
  test.each([
    "127.0.0.1",
    "10.0.0.5",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "::",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
    "not-an-ip",
  ])("blocks %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  test.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("allows %s", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe("in production", () => {
  let server: ReturnType<typeof Bun.serve>;
  beforeAll(() => {
    env.NODE_ENV = "production";
    server = Bun.serve({ port: 0, fetch: () => Response.json({ secret: true }) });
  });
  afterAll(() => {
    env.NODE_ENV = originalEnv;
    server.stop(true);
  });

  test("takes a base URL or a full endpoint", () => {
    expect(normalizeBaseUrl("https://api.example.com/v1/")).toBe("https://api.example.com/v1");
    expect(normalizeBaseUrl("https://api.example.com/v1/chat/completions")).toBe("https://api.example.com/v1");
  });

  test.each([
    "http://api.example.com/v1",
    "ftp://api.example.com",
    "https://user:pass@api.example.com",
    "https://127.0.0.1/v1",
    "https://2130706433/v1",
    "https://0x7f.0.0.1/v1",
    "https://[::1]/v1",
    "https://[::ffff:169.254.169.254]/v1",
    "https://169.254.169.254/latest/meta-data",
    "nonsense",
  ])("refuses %s", (raw) => {
    expect(() => normalizeBaseUrl(raw)).toThrow("can't be used");
  });

  test("won't call a saved URL that points at a private address", () => {
    expect(() => postToCustomEndpoint(`http://127.0.0.1:${server.port}`, {}, "{}")).toThrow("can't be used");
  });

  test("won't resolve a hostname to a private address", async () => {
    const error = await new Promise<Error | null>((resolve) => {
      guardedLookup("localhost", {}, (err) => resolve(err));
    });
    expect(error?.message).toBe("Blocked address");
  });
});

describe("outside production", () => {
  test("reaches a local server for development, and reports failures", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (req) =>
        new URL(req.url).pathname === "/v1/chat/completions"
          ? Response.json({ choices: [] })
          : Response.json({ error: "nope" }, { status: 404 }),
    });
    const good = await postToCustomEndpoint(`http://127.0.0.1:${server.port}/v1`, {}, "{}");
    const bad = await postToCustomEndpoint(`http://127.0.0.1:${server.port}/other`, {}, "{}");
    server.stop(true);
    expect(good).toEqual({ ok: true, body: { choices: [] } });
    expect(bad.ok).toBe(false);
  });

  test("doesn't follow a redirect", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(null, { status: 302, headers: { Location: "http://127.0.0.1:1/" } }),
    });
    const result = await postToCustomEndpoint(`http://127.0.0.1:${server.port}`, {}, "{}");
    server.stop(true);
    expect(result.ok).toBe(false);
  });
});
