import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { checkDiscordUrl, checkSlackUrl, type Notice, plainText, signWebhook } from "./channels";

const notice: Notice = {
  workspace: "Acme",
  mailbox: "support@acme.test",
  fromName: "Priya Raman",
  fromAddress: "priya@lumen.test",
  subject: "Can't verify our domain",
  excerpt: "We added the TXT record yesterday",
  url: "https://hellobox.app/inbox?thread=t1",
  receivedAt: new Date(0).toISOString(),
  threadId: "t1",
  messageId: "m1",
  count: 1,
};

describe("webhook URLs", () => {
  test("accepts Discord's own webhook URLs and normalizes the host", () => {
    expect(checkDiscordUrl("https://discordapp.com/api/webhooks/123/abc-DEF_9/")).toBe("https://discord.com/api/webhooks/123/abc-DEF_9");
  });
  test("rejects other hosts pretending to be Discord", () => {
    expect(() => checkDiscordUrl("https://discord.com.evil.test/api/webhooks/1/x")).toThrow();
    expect(() => checkDiscordUrl("https://evil.test/api/webhooks/1/x")).toThrow();
    expect(() => checkDiscordUrl("https://discord.com/channels/1/2")).toThrow();
  });
  test("only takes hooks.slack.com for Slack", () => {
    expect(checkSlackUrl("https://hooks.slack.com/services/T1/B2/xyz")).toBe("https://hooks.slack.com/services/T1/B2/xyz");
    expect(() => checkSlackUrl("https://slack.com/services/T1/B2/xyz")).toThrow();
  });
});

describe("wording", () => {
  test("a preview names the sender, mailbox and subject", () => {
    expect(plainText(notice, true)).toEqual({
      title: "Priya Raman → support@acme.test",
      body: "Can't verify our domain\nWe added the TXT record yesterday",
    });
  });
  test("without a preview, nothing about the message leaves", () => {
    const { title, body } = plainText(notice, false);
    expect(title).toBe("New mail in support@acme.test");
    expect(`${title} ${body}`).not.toContain("Priya");
    expect(`${title} ${body}`).not.toContain("verify");
  });
  test("a burst becomes one summary", () => {
    const burst = { ...notice, count: 3, lines: [{ from: "A", subject: "One", mailbox: "a@x.test" }, { from: "B", subject: "", mailbox: "b@x.test" }] };
    expect(plainText(burst, true).title).toBe("3 new messages in a@x.test, b@x.test");
    expect(plainText(burst, true).body).toBe("A: One\nB: (no subject)");
    expect(plainText(burst, false).title).toBe("3 new messages");
  });
});

test("webhook signatures are HMAC-SHA256 of timestamp.body", () => {
  const expected = createHmac("sha256", "whsec_test").update("1700000000.{\"a\":1}").digest("hex");
  expect(signWebhook("whsec_test", "1700000000", "{\"a\":1}")).toBe(`v1=${expected}`);
});
