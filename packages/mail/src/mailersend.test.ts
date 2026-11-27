import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, test } from "bun:test";
import { handleMailersendEvents, handleMailersendInbound, mailersendInboundId } from "./mailersend";

const TOKEN = "inbound-token";
const stored: { emailId: string; raw: string }[] = [];
const events: [string, string, string][] = [];

// Stands in for the database, storage and MailerSend. Only connection c1 exists.
const steps = {
  load: async (connectionId: string) =>
    connectionId === "c1" ? { workspaceId: "w1", inboundToken: TOKEN, secrets: { d1: "secret-1" } } : null,
  receive: async (email: { emailId: string; raw: Uint8Array }) => {
    stored.push({ emailId: email.emailId, raw: new TextDecoder().decode(email.raw) });
    return { emailId: email.emailId };
  },
  recordEvent: async (_connectionId: string, providerEventId: string, type: string, messageId: string) => {
    events.push([providerEventId, type, messageId]);
  },
} as never;

beforeEach(() => {
  stored.length = 0;
  events.length = 0;
});

const RAW = "From: grace@example.org\r\nTo: support@acme.com\r\nSubject: Hi\r\n\r\nHello";
const inbound = { type: "inbound.message", data: { id: "m1", raw: RAW, subject: "Hi", recipients: { rcptTo: [{ email: "support@acme.com" }] } } };

describe("handleMailersendInbound", () => {
  test("stores the email", async () => {
    expect(await handleMailersendInbound("c1", { key: TOKEN, payload: inbound }, steps)).toEqual({ status: 200 });
    expect(stored).toEqual([{ emailId: mailersendInboundId(inbound.data), raw: RAW }]);
  });

  test("answers MailerSend's test post without storing anything", async () => {
    expect(await handleMailersendInbound("c1", { key: TOKEN, payload: { type: "webhook.test" } }, steps)).toEqual({ status: 200 });
    expect(stored).toHaveLength(0);
  });

  test("refuses a wrong key and unknown connections", async () => {
    expect(await handleMailersendInbound("c1", { key: "wrong", payload: inbound }, steps)).toEqual({ status: 401 });
    expect(await handleMailersendInbound("c2", { key: TOKEN, payload: inbound }, steps)).toEqual({ status: 404 });
    expect(stored).toHaveLength(0);
  });
});

const signed = (payload: unknown, secret = "secret-1") => {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  return { body, signature: createHmac("sha256", secret).update(body).digest("hex") };
};

describe("handleMailersendEvents", () => {
  const delivered = { type: "activity.delivered", data: { id: "a1", domain_id: "d1", message_id: "msg1", recipient: "g@example.org" } };

  test("records events signed with the domain's secret", async () => {
    expect(await handleMailersendEvents("c1", signed(delivered), steps)).toEqual({ status: 200 });
    expect(events).toEqual([["a1", "email.delivered", "msg1"]]);
  });

  test("refuses another secret, an unknown domain and no signature", async () => {
    expect(await handleMailersendEvents("c1", signed(delivered, "other"), steps)).toEqual({ status: 401 });
    expect(await handleMailersendEvents("c1", signed({ ...delivered, data: { ...delivered.data, domain_id: "d9" } }), steps)).toEqual({ status: 401 });
    expect(await handleMailersendEvents("c1", { ...signed(delivered), signature: null }, steps)).toEqual({ status: 401 });
    expect(events).toHaveLength(0);
  });

  test("ignores events it doesn't track", async () => {
    expect(await handleMailersendEvents("c1", signed({ ...delivered, type: "activity.opened" }), steps)).toEqual({ status: 200 });
    expect(events).toHaveLength(0);
  });
});
