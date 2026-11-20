import { describe, expect, it } from "bun:test";
import { Webhook } from "svix";
import { verifyWebhook } from "./webhook";

const secret = `whsec_${Buffer.from("testsecrettestsecrettestsecret12").toString("base64")}`;
const body = JSON.stringify({ type: "email.received", data: { email_id: "abc" } });

function signedHeaders(payload: string) {
  const timestamp = new Date();
  return new Headers({
    "svix-id": "msg_1",
    "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
    "svix-signature": new Webhook(secret).sign("msg_1", timestamp, payload),
  });
}

describe("verifyWebhook", () => {
  it("returns the parsed event for a valid signature", () => {
    expect(verifyWebhook(body, signedHeaders(body), secret).data.email_id).toBe("abc");
  });
  it("rejects a changed body", () => {
    expect(() => verifyWebhook(`${body} `, signedHeaders(body), secret)).toThrow();
  });
  it("rejects missing headers", () => {
    expect(() => verifyWebhook(body, new Headers(), secret)).toThrow();
  });
});
