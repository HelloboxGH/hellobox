import { beforeEach, describe, expect, test } from "bun:test";
import { brevoInboundId, brevoTokenFrom, handleBrevoEvents, handleBrevoInbound } from "./brevo";

const TOKEN = "webhook-token";
const stored: { emailId: string; raw: string; hint: unknown }[] = [];
const events: [string, string, string][] = [];
const downloads: string[] = [];
let failStore = false;

// Stands in for the database, storage and Brevo. Only connection c1 exists.
const steps = {
  load: async (connectionId: string) => (connectionId === "c1" ? { workspaceId: "w1", token: TOKEN } : null),
  download: async (_connectionId: string, attachment: { DownloadToken: string }) => {
    downloads.push(attachment.DownloadToken);
    return new TextEncoder().encode("file");
  },
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
  downloads.length = 0;
  failStore = false;
});

const item = {
  Uuid: ["u1"],
  MessageId: "<orig@example.org>",
  From: { Address: "grace@example.org" },
  To: [{ Address: "support@acme.com" }],
  Subject: "Hi",
  RawTextBody: "Hello",
  Attachments: [{ Name: "a.txt", ContentType: "text/plain", DownloadToken: "t1" }],
};

describe("brevoTokenFrom", () => {
  test("reads the bearer token or our header", () => {
    expect(brevoTokenFrom({ authorization: "Bearer abc", token: null })).toBe("abc");
    expect(brevoTokenFrom({ authorization: null, token: "abc" })).toBe("abc");
    expect(brevoTokenFrom({ authorization: "Basic xyz", token: null })).toBeNull();
  });
});

describe("handleBrevoInbound", () => {
  test("downloads the attachments and stores each email", async () => {
    expect(await handleBrevoInbound("c1", { token: TOKEN, payload: { items: [item] } }, steps)).toEqual({ status: 200 });
    expect(downloads).toEqual(["t1"]);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.emailId).toBe(brevoInboundId(item));
    expect(stored[0]?.raw).toContain("Message-ID: <orig@example.org>");
    expect(stored[0]?.raw).toContain("a.txt");
    expect(stored[0]?.hint).toEqual({ recipients: ["support@acme.com"] });
  });

  test("the same email gets the same id, so a retry isn't a second email", () => {
    expect(brevoInboundId(item)).toBe(brevoInboundId({ ...item }));
    expect(brevoInboundId(item)).toMatch(/^bv_[0-9a-f]{40}$/);
    expect(brevoInboundId(item)).not.toBe(brevoInboundId({ ...item, Uuid: ["u2"] }));
  });

  test("refuses a wrong token and unknown connections", async () => {
    expect(await handleBrevoInbound("c1", { token: "wrong", payload: { items: [item] } }, steps)).toEqual({ status: 401 });
    expect(await handleBrevoInbound("c1", { token: null, payload: { items: [item] } }, steps)).toEqual({ status: 401 });
    expect(await handleBrevoInbound("c2", { token: TOKEN, payload: { items: [item] } }, steps)).toEqual({ status: 404 });
    expect(stored).toHaveLength(0);
  });

  test("a post without items is refused", async () => {
    expect(await handleBrevoInbound("c1", { token: TOKEN, payload: {} }, steps)).toEqual({ status: 400 });
  });

  test("a failed store throws, so Brevo sends it again", async () => {
    failStore = true;
    await expect(handleBrevoInbound("c1", { token: TOKEN, payload: { items: [item] } }, steps)).rejects.toThrow(/storage/);
  });
});

describe("handleBrevoEvents", () => {
  test("records delivery events, one or a batch, and skips the rest", async () => {
    await handleBrevoEvents("c1", { token: TOKEN, payload: { event: "delivered", email: "g@example.org", "message-id": "<m1@relay>", ts_epoch: 1 } }, steps);
    await handleBrevoEvents(
      "c1",
      {
        token: TOKEN,
        payload: [
          { event: "opened", email: "g@example.org", "message-id": "<m1@relay>" },
          { event: "hard_bounce", email: "l@example.net", "message-id": "m2@relay", ts_epoch: 2 },
        ],
      },
      steps,
    );
    expect(events).toEqual([
      ["delivered:m1@relay:g@example.org:1", "email.delivered", "m1@relay"],
      ["hard_bounce:m2@relay:l@example.net:2", "email.bounced", "m2@relay"],
    ]);
  });

  test("refuses a wrong token", async () => {
    expect(await handleBrevoEvents("c1", { token: "wrong", payload: { event: "delivered", "message-id": "m1" } }, steps)).toEqual({ status: 401 });
    expect(events).toHaveLength(0);
  });
});
