import { beforeEach, describe, expect, test } from "bun:test";

import { handlePostmarkEvent, handlePostmarkInbound } from "./postmark";

const stored: { emailId: string; raw: string; hint: unknown }[] = [];
const delivered: [string, string, string, string][] = [];

// Stands in for the database, storage and queue. Only connection c1 exists.
const steps = {
  load: async (connectionId: string) => (connectionId === "c1" ? { workspaceId: "w1", password: "s3cret" } : null),
  receive: async (email: { emailId: string; raw: Uint8Array; hint?: unknown }) => {
    stored.push({ emailId: email.emailId, raw: new TextDecoder().decode(email.raw), hint: email.hint });
    return { emailId: email.emailId };
  },
  recordEvent: async (connectionId: string, providerEventId: string, type: string, event: { MessageID: string }) => {
    delivered.push([connectionId, providerEventId, type, event.MessageID]);
  },
};

const auth = (password: string) => `Basic ${Buffer.from(`hellobox:${password}`).toString("base64")}`;
const inbound = {
  MessageID: "pm-in-1",
  FromFull: { Email: "ada@example.com" },
  ToFull: [{ Email: "support@acme.com" }],
  Subject: "Hello",
  RawEmail: "From: ada@example.com\r\nTo: support@acme.com\r\nSubject: Hello\r\n\r\nHi",
};

beforeEach(() => {
  stored.length = 0;
  delivered.length = 0;
});

describe("handlePostmarkInbound", () => {
  test("stores the raw email, then answers 200", async () => {
    expect(await handlePostmarkInbound("c1", auth("s3cret"), inbound, steps)).toEqual({ status: 200 });
    expect(stored).toEqual([{ emailId: "pm-in-1", raw: inbound.RawEmail, hint: { recipients: ["support@acme.com"] } }]);
  });

  test("refuses wrong or missing credentials without storing anything", async () => {
    expect(await handlePostmarkInbound("c1", auth("wrong"), inbound, steps)).toEqual({ status: 401 });
    expect(await handlePostmarkInbound("c1", null, inbound, steps)).toEqual({ status: 401 });
    expect(await handlePostmarkInbound("nope", auth("s3cret"), inbound, steps)).toEqual({ status: 401 });
    expect(stored).toHaveLength(0);
  });
});

describe("handlePostmarkEvent", () => {
  test("records deliveries and bounces against Postmark's message id", async () => {
    await handlePostmarkEvent("c1", auth("s3cret"), "trace-1", { RecordType: "Delivery", MessageID: "pm-out-1" }, steps);
    await handlePostmarkEvent("c1", auth("s3cret"), null, { RecordType: "Bounce", Type: "HardBounce", ID: 9, MessageID: "pm-out-2" }, steps);
    expect(delivered).toEqual([
      ["c1", "trace-1", "email.delivered", "pm-out-1"],
      ["c1", "Bounce:9", "email.bounced", "pm-out-2"],
    ]);
  });

  test("answers Postmark's test posts with 200, and refuses bad credentials", async () => {
    expect(await handlePostmarkEvent("c1", auth("s3cret"), null, { RecordType: "Open" }, steps)).toEqual({ status: 200 });
    expect(await handlePostmarkEvent("c1", auth("wrong"), null, { RecordType: "Delivery", MessageID: "x" }, steps)).toEqual({ status: 401 });
    expect(delivered).toHaveLength(0);
  });
});
