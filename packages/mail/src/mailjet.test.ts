import { beforeEach, describe, expect, test } from "bun:test";
import { handleMailjetEvents, handleMailjetInbound, mailjetInboundId } from "./mailjet";

const TOKEN = "webhook-token";
const stored: { emailId: string; hint: unknown }[] = [];
const events: [string, string, string][] = [];

// Stands in for the database, storage and Mailjet. Only connection c1 exists.
const steps = {
  load: async (connectionId: string) => (connectionId === "c1" ? { workspaceId: "w1", token: TOKEN } : null),
  receive: async (email: { emailId: string; hint?: unknown }) => {
    stored.push({ emailId: email.emailId, hint: email.hint });
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

const payload = {
  Sender: "grace@example.org",
  Recipient: "Support@acme.com",
  Subject: "Hi",
  Headers: { From: "grace@example.org", To: "support@acme.com", "Message-ID": "<orig@example.org>" },
  "Text-part": "Hello",
};

describe("handleMailjetInbound", () => {
  test("stores the email for its envelope recipient", async () => {
    expect(await handleMailjetInbound("c1", { key: TOKEN, payload }, steps)).toEqual({ status: 200 });
    expect(stored).toEqual([{ emailId: mailjetInboundId(payload), hint: { recipients: ["support@acme.com"] } }]);
  });

  test("each recipient's copy is its own email, and a retry isn't a second one", () => {
    expect(mailjetInboundId(payload)).toBe(mailjetInboundId({ ...payload }));
    expect(mailjetInboundId(payload)).not.toBe(mailjetInboundId({ ...payload, Recipient: "sales@acme.com" }));
  });

  test("refuses a wrong key, unknown connections and empty posts", async () => {
    expect(await handleMailjetInbound("c1", { key: "wrong", payload }, steps)).toEqual({ status: 401 });
    expect(await handleMailjetInbound("c2", { key: TOKEN, payload }, steps)).toEqual({ status: 404 });
    expect(await handleMailjetInbound("c1", { key: TOKEN, payload: {} }, steps)).toEqual({ status: 400 });
    expect(stored).toHaveLength(0);
  });
});

describe("handleMailjetEvents", () => {
  test("records a grouped list, skipping events it doesn't track", async () => {
    await handleMailjetEvents(
      "c1",
      {
        key: TOKEN,
        payload: [
          { event: "sent", time: 1, email: "g@example.org", CustomID: "abc@hellobox.app", Message_GUID: "u1" },
          { event: "open", time: 2, email: "g@example.org", CustomID: "abc@hellobox.app" },
          { event: "bounce", time: 3, email: "l@example.net", hard_bounce: true, MessageID: 42, Message_GUID: "u2" },
        ],
      },
      steps,
    );
    expect(events).toEqual([
      ["sent:u1:g@example.org:1", "email.delivered", "abc@hellobox.app"],
      ["bounce:u2:l@example.net:3", "email.bounced", "42"],
    ]);
  });

  test("refuses a wrong key", async () => {
    expect(await handleMailjetEvents("c1", { key: null, payload: { event: "sent", CustomID: "x" } }, steps)).toEqual({ status: 401 });
  });
});
