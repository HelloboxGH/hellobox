import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { customEventsFrom, verifyCustomEvent } from "./events";
import { checkSpec, type CustomSpec } from "./spec";

type Events = NonNullable<CustomSpec["events"]>;
const body = new TextEncoder().encode('{"event":"delivered"}');
const secrets = { WEBHOOK_SECRET: "shh" };
const now = 1_800_000_000_000;

describe("verifyCustomEvent", () => {
  test("hmac-sha256 over the body, hex with a prefix", () => {
    const verify = { type: "hmac-sha256", header: "X-Sig", secret: "<WEBHOOK_SECRET>", encoding: "hex", prefix: "sha256=" } as const;
    const signature = createHmac("sha256", "shh").update(body).digest("hex");
    expect(verifyCustomEvent(verify, secrets, { headers: { "x-sig": `sha256=${signature}` }, body })).toBe(true);
    expect(verifyCustomEvent(verify, secrets, { headers: { "x-sig": `sha256=${signature.slice(0, -1)}${signature.endsWith("0") ? "1" : "0"}` }, body })).toBe(false);
    expect(verifyCustomEvent(verify, secrets, { headers: { "x-sig": signature }, body })).toBe(false);
    expect(verifyCustomEvent(verify, secrets, { headers: {}, body })).toBe(false);
  });

  test("hmac-sha256 with a timestamp, base64, within five minutes", () => {
    const verify = { type: "hmac-sha256", header: "X-Sig", secret: "<WEBHOOK_SECRET>", encoding: "base64", timestampHeader: "X-Time" } as const;
    const stamp = String(now / 1000);
    const signature = createHmac("sha256", "shh").update(`${stamp}.`).update(body).digest("base64");
    const headers = { "x-sig": signature, "x-time": stamp };
    expect(verifyCustomEvent(verify, secrets, { headers, body }, now)).toBe(true);
    expect(verifyCustomEvent(verify, secrets, { headers, body }, now + 301_000)).toBe(false);
  });

  test("standard webhooks", () => {
    const key = Buffer.from("secret-bytes").toString("base64");
    const signature = createHmac("sha256", Buffer.from(key, "base64")).update(`msg_1.${now / 1000}.`).update(body).digest("base64");
    const headers = { "webhook-id": "msg_1", "webhook-timestamp": String(now / 1000), "webhook-signature": `v1,${signature}` };
    expect(verifyCustomEvent({ type: "standard-webhooks", secret: "<WEBHOOK_SECRET>" }, { WEBHOOK_SECRET: `whsec_${key}` }, { headers, body }, now)).toBe(true);
  });

  test("token, and no check at all", () => {
    const verify = { type: "token", header: "X-Token", secret: "<WEBHOOK_SECRET>" } as const;
    expect(verifyCustomEvent(verify, secrets, { headers: { "x-token": "shh" }, body })).toBe(true);
    expect(verifyCustomEvent(verify, secrets, { headers: { "x-token": "nope" }, body })).toBe(false);
    expect(verifyCustomEvent(undefined, secrets, { headers: {}, body })).toBe(true);
  });
});

describe("customEventsFrom", () => {
  const spec: Events = {
    list: "events",
    type: "event",
    map: { delivered: "delivered", bounce: "bounced", spam: "complained" },
    id: "message.id",
    recipient: "email",
    reason: "error.text",
  };

  test("reads mapped events and skips the rest", () => {
    const events = customEventsFrom(spec, {
      events: [
        { event: "delivered", message: { id: "<p-1>" }, email: "Grace@Example.org" },
        { event: "bounce", message: { id: "p-2" }, email: "x@example.org", error: { text: "550 no such user" } },
        { event: "opened", message: { id: "p-3" } },
        { event: "spam" },
      ],
    });
    expect(events.map(({ type, messageId, recipient, reason }) => ({ type, messageId, recipient, reason }))).toEqual([
      { type: "email.delivered", messageId: "p-1", recipient: "grace@example.org", reason: undefined },
      { type: "email.bounced", messageId: "p-2", recipient: "x@example.org", reason: "550 no such user" },
    ]);
    expect(events[0]!.eventId).toMatch(/^custom_[a-f0-9]{40}$/);
  });

  test("one event per post when there's no list", () => {
    expect(customEventsFrom({ ...spec, list: undefined }, { event: "spam", message: { id: 7 } })).toMatchObject([{ type: "email.complained", messageId: "7" }]);
  });

  test("a spec's events check out without a verify", () => {
    const check = checkSpec({
      version: 1,
      name: "Acme",
      send: { method: "POST", url: "https://x.example", headers: {} },
      events: { type: "event", map: { delivered: "delivered" }, id: "id" },
    });
    expect(check.ok).toBe(true);
  });
});
