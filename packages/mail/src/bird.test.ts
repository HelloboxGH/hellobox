import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, test } from "bun:test";
import { handleBirdWebhook } from "./bird";

const KEY = Buffer.from("key-bytes");
const SECRET = `whsec_${KEY.toString("base64")}`;
const NOW = 1_800_000_000_000;
const saved: [string, string, string][] = [];
const ingested: string[] = [];
const delivered: [string, string][] = [];

// Stands in for the database, the queue and Bird. Only connection c1 exists.
const steps = {
  load: async (connectionId: string) => (connectionId === "c1" ? { secret: SECRET } : null),
  save: async (_connectionId: string, providerEventId: string, type: string, emailId: string) => {
    saved.push([providerEventId, type, emailId]);
  },
  ingest: async (_connectionId: string, emailId: string) => ingested.push(emailId),
  recordDelivery: async (_connectionId: string, type: string, emailId: string) => delivered.push([type, emailId]),
};

beforeEach(() => {
  saved.length = 0;
  ingested.length = 0;
  delivered.length = 0;
});

function signed(payload: unknown, id = "msg_1") {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const timestamp = String(NOW / 1000);
  const signature = `v1,${createHmac("sha256", KEY).update(`${id}.${timestamp}.`).update(body).digest("base64")}`;
  return { id, timestamp, signature, body };
}

describe("handleBirdWebhook", () => {
  test("received mail is saved with its hint, then ingested", async () => {
    const post = signed({ type: "email.received", data: { inbound_message_id: "rem_1", to: ["support@acme.com"] } });
    expect(await handleBirdWebhook("c1", post, steps, NOW)).toEqual({ status: 200 });
    expect(saved).toEqual([["msg_1", "email.received", "rem_1"]]);
    expect(ingested).toEqual(["rem_1"]);
  });

  test("delivery events are recorded against the sent email", async () => {
    await handleBirdWebhook("c1", signed({ type: "email.bounced", data: { email_id: "em_1", recipient: "g@example.org", bounce_type: "hard" } }), steps, NOW);
    expect(delivered).toEqual([["email.bounced", "em_1"]]);
  });

  test("refuses bad signatures and unknown connections, ignores other events", async () => {
    const post = signed({ type: "email.delivered", data: { email_id: "em_1" } });
    expect(await handleBirdWebhook("c1", { ...post, signature: "v1,AAAA" }, steps, NOW)).toEqual({ status: 401 });
    expect(await handleBirdWebhook("c2", post, steps, NOW)).toEqual({ status: 404 });
    expect(await handleBirdWebhook("c1", signed({ type: "email.opened", data: { email_id: "em_1" } }), steps, NOW)).toEqual({ status: 200 });
    expect(delivered).toHaveLength(0);
  });
});
