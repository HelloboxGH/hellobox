import { generateKeyPairSync, sign } from "node:crypto";
import { beforeEach, describe, expect, test } from "bun:test";
import { handleSendgridEvents, handleSendgridInbound, sendgridInboundId } from "./sendgrid";

const NOW = 1_800_000_000_000;
const TOKEN = "inbound-token";
const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const PUBLIC_KEY = publicKey.export({ format: "der", type: "spki" }).toString("base64");

const stored: { emailId: string; raw: string; hint: unknown }[] = [];
const events: [string, string, string][] = [];
let failStore = false;

// Stands in for the database, storage and SendGrid. Only connection c1 exists.
const steps = {
  load: async (connectionId: string) =>
    connectionId === "c1" ? { workspaceId: "w1", inboundToken: TOKEN, publicKey: PUBLIC_KEY } : null,
  receive: async (email: { emailId: string; raw: Uint8Array; hint?: unknown }) => {
    if (failStore) throw new Error("storage is down");
    stored.push({ emailId: email.emailId, raw: new TextDecoder().decode(email.raw), hint: email.hint });
    return { emailId: email.emailId };
  },
  recordEvent: async (_connectionId: string, providerEventId: string, type: string, messageId: string) => {
    events.push([providerEventId, type, messageId]);
  },
} as never;

beforeEach(() => {
  stored.length = 0;
  events.length = 0;
  failStore = false;
});

const RAW = "From: grace@example.org\r\nTo: support@acme.com\r\nSubject: Hi\r\n\r\nHello";
const fields = { email: RAW, envelope: JSON.stringify({ to: ["Support@acme.com"], from: "grace@example.org" }), SPF: "pass" };

describe("handleSendgridInbound", () => {
  test("stores the raw message with the envelope's recipients and SPF", async () => {
    expect(await handleSendgridInbound("c1", { key: TOKEN, fields }, steps)).toEqual({ status: 200 });
    expect(stored).toEqual([
      {
        emailId: sendgridInboundId(new TextEncoder().encode(RAW)),
        raw: RAW,
        hint: { recipients: ["support@acme.com"], authentication: { spf: "pass" } },
      },
    ]);
  });

  test("the same message gets the same id, so a retry isn't a second email", () => {
    const raw = new TextEncoder().encode(RAW);
    expect(sendgridInboundId(raw)).toBe(sendgridInboundId(raw));
    expect(sendgridInboundId(raw)).toMatch(/^sg_[0-9a-f]{40}$/);
  });

  test("refuses a wrong or missing key, and unknown connections", async () => {
    expect(await handleSendgridInbound("c1", { key: "wrong", fields }, steps)).toEqual({ status: 401 });
    expect(await handleSendgridInbound("c1", { key: null, fields }, steps)).toEqual({ status: 401 });
    expect(await handleSendgridInbound("c2", { key: TOKEN, fields }, steps)).toEqual({ status: 404 });
    expect(stored).toHaveLength(0);
  });

  test("a post without the raw message is refused", async () => {
    expect(await handleSendgridInbound("c1", { key: TOKEN, fields: { envelope: "{}" } }, steps)).toEqual({ status: 400 });
  });

  test("a broken envelope still stores the message", async () => {
    await handleSendgridInbound("c1", { key: TOKEN, fields: { email: RAW, envelope: "{" } }, steps);
    expect(stored[0]?.hint).toEqual({ recipients: [] });
  });

  test("a failed store throws, so SendGrid sends it again", async () => {
    failStore = true;
    await expect(handleSendgridInbound("c1", { key: TOKEN, fields }, steps)).rejects.toThrow(/storage/);
  });
});

function signedPost(payload: unknown, at = NOW) {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const timestamp = String(Math.floor(at / 1000));
  const signature = sign("sha256", Buffer.concat([Buffer.from(timestamp), Buffer.from(body)]), privateKey).toString("base64");
  return { signature, timestamp, body };
}

describe("handleSendgridEvents", () => {
  test("records the delivery events and skips the rest", async () => {
    const post = signedPost([
      { event: "delivered", email: "grace@example.org", sg_event_id: "e1", sg_message_id: "m1.filter0001.1.2" },
      { event: "open", email: "grace@example.org", sg_event_id: "e2", sg_message_id: "m1.filter0001.1.2" },
      { event: "bounce", type: "bounce", email: "linus@example.net", sg_event_id: "e3", sg_message_id: "m2.filter0002.3.4" },
      { event: "delivered", email: "grace@example.org", sg_event_id: "e4" },
    ]);
    expect(await handleSendgridEvents("c1", post, steps, NOW)).toEqual({ status: 200 });
    expect(events).toEqual([
      ["e1", "email.delivered", "m1"],
      ["e3", "email.bounced", "m2"],
    ]);
  });

  test("refuses unsigned, changed and old posts", async () => {
    const post = signedPost([{ event: "delivered", sg_message_id: "m1" }]);
    expect(await handleSendgridEvents("c1", { ...post, signature: null }, steps, NOW)).toEqual({ status: 401 });
    expect(await handleSendgridEvents("c1", { ...post, body: new TextEncoder().encode("[]") }, steps, NOW)).toEqual({ status: 401 });
    expect(await handleSendgridEvents("c1", post, steps, NOW + 3_600_000)).toEqual({ status: 401 });
    expect(await handleSendgridEvents("c2", post, steps, NOW)).toEqual({ status: 404 });
    expect(events).toHaveLength(0);
  });
});
