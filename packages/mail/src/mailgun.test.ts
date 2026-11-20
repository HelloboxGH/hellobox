import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, test } from "bun:test";
import { mailgunInboundId } from "@hellobox/providers";
import { handleMailgunEvent, handleMailgunInbound } from "./mailgun";

const NOW = 1_770_920_772_000;
const KEY = "signing-key";
const storageUrl = "https://storage-us-east4.api.mailgun.net/v3/domains/acme.com/messages/BAAB";

const stored: { emailId: string; raw: string; hint: unknown }[] = [];
const events: [string, string, string, string][] = [];
const tokens = new Set<string>();
let failStore = false;

// Stands in for the database, Redis, storage and Mailgun. Only connection c1 exists.
const steps = {
  load: async (connectionId: string) => (connectionId === "c1" ? { workspaceId: "w1", signingKey: KEY } : null),
  seen: async (token: string) => tokens.has(token),
  remember: async (token: string) => {
    tokens.add(token);
  },
  fetchRaw: async (_connectionId: string, url: string) => new TextEncoder().encode(`Subject: from ${url}\r\n\r\nHi`),
  receive: async (email: { emailId: string; raw: Uint8Array; hint?: unknown }) => {
    if (failStore) throw new Error("storage is down");
    stored.push({ emailId: email.emailId, raw: new TextDecoder().decode(email.raw), hint: email.hint });
    return { emailId: email.emailId };
  },
  recordEvent: async (connectionId: string, providerEventId: string, type: string, messageId: string) => {
    events.push([connectionId, providerEventId, type, messageId]);
  },
};

function signed(token: string, at = NOW) {
  const timestamp = String(Math.floor(at / 1000));
  return { timestamp, token, signature: createHmac("sha256", KEY).update(timestamp + token).digest("hex") };
}

const notification = (token: string, extra: Record<string, string> = {}) => ({
  ...signed(token),
  recipient: "Support@acme.com",
  from: "Ada <ada@example.com>",
  subject: "Hello",
  "message-url": storageUrl,
  ...extra,
});

beforeEach(() => {
  stored.length = 0;
  events.length = 0;
  tokens.clear();
  failStore = false;
});

describe("handleMailgunInbound", () => {
  test("fetches the raw message and stores it before answering 200", async () => {
    expect(await handleMailgunInbound("c1", notification("t1"), steps, NOW)).toEqual({ status: 200 });
    expect(stored).toEqual([
      { emailId: mailgunInboundId(storageUrl), raw: `Subject: from ${storageUrl}\r\n\r\nHi`, hint: { recipients: ["support@acme.com"] } },
    ]);
  });

  test("refuses a bad signature, an old one and an unknown connection without storing", async () => {
    expect(await handleMailgunInbound("c1", { ...notification("t1"), signature: "00" }, steps, NOW)).toEqual({ status: 401 });
    const old = { ...notification("t2"), ...signed("t2", NOW - 20 * 60 * 1000) };
    expect(await handleMailgunInbound("c1", old, steps, NOW)).toEqual({ status: 401 });
    expect(await handleMailgunInbound("nope", notification("t3"), steps, NOW)).toEqual({ status: 404 });
    expect(stored).toHaveLength(0);
  });

  test("a replayed token gets a 200 and does nothing", async () => {
    await handleMailgunInbound("c1", notification("t1"), steps, NOW);
    expect(await handleMailgunInbound("c1", notification("t1"), steps, NOW)).toEqual({ status: 200 });
    expect(stored).toHaveLength(1);
  });

  test("when storing fails, the token isn't remembered, so Mailgun's retry still works", async () => {
    failStore = true;
    await expect(handleMailgunInbound("c1", notification("t1"), steps, NOW)).rejects.toThrow("storage is down");
    failStore = false;
    expect(await handleMailgunInbound("c1", notification("t1"), steps, NOW)).toEqual({ status: 200 });
    expect(stored).toHaveLength(1);
  });

  test("won't fetch a message URL outside Mailgun", async () => {
    const evil = notification("t1", { "message-url": "https://evil.example/messages/1" });
    expect(await handleMailgunInbound("c1", evil, steps, NOW)).toEqual({ status: 400 });
    expect(stored).toHaveLength(0);
  });
});

describe("handleMailgunEvent", () => {
  test("records deliveries and permanent failures by message id", async () => {
    await handleMailgunEvent("c1", { signature: signed("e1"), "event-data": { id: "ev1", event: "delivered", message: { headers: { "message-id": "m1@acme.com" } } } }, steps, NOW);
    await handleMailgunEvent("c1", { signature: signed("e2"), "event-data": { id: "ev2", event: "failed", severity: "permanent", message: { headers: { "message-id": "<m2@acme.com>" } } } }, steps, NOW);
    expect(events).toEqual([
      ["c1", "ev1", "email.delivered", "m1@acme.com"],
      ["c1", "ev2", "email.bounced", "m2@acme.com"],
    ]);
  });

  test("ignores events the inbox doesn't show, and refuses bad signatures", async () => {
    expect(await handleMailgunEvent("c1", { signature: signed("e1"), "event-data": { event: "opened" } }, steps, NOW)).toEqual({ status: 200 });
    expect(await handleMailgunEvent("c1", { signature: { ...signed("e2"), signature: "00" }, "event-data": { event: "delivered" } }, steps, NOW)).toEqual({ status: 401 });
    expect(await handleMailgunEvent("c1", {}, steps, NOW)).toEqual({ status: 401 });
    expect(events).toHaveLength(0);
  });
});
