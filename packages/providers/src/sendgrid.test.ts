import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  sendgridAddress,
  sendgridDeliveryType,
  sendgridDomainRecords,
  sendgridEventDetail,
  sendgridMailBody,
  sendgridMessageId,
  verifySendgridSignature,
} from "./sendgrid";

describe("sendgridAddress", () => {
  test("splits names from addresses", () => {
    expect(sendgridAddress("Ada <ada@example.com>")).toEqual({ email: "ada@example.com", name: "Ada" });
    expect(sendgridAddress('"Ada L." <ada@example.com>')).toEqual({ email: "ada@example.com", name: "Ada L." });
    expect(sendgridAddress(" grace@example.org ")).toEqual({ email: "grace@example.org" });
  });
});

describe("sendgridMailBody", () => {
  test("keeps our Message-ID, threading headers and tags", () => {
    const body = sendgridMailBody(
      {
        from: "Ada <ada@example.com>",
        to: ["grace@example.org"],
        bcc: ["audit@example.com"],
        replyTo: ["support@example.com"],
        subject: "Re: Hello",
        html: "<p>Hi</p>",
        text: "Hi",
        headers: { "Message-ID": "<abc@hellobox.app>", "In-Reply-To": "<prev@example.org>" },
        tags: { thread: "t1" },
      },
      [{ filename: "a.txt", contentType: "text/plain", content: new TextEncoder().encode("hey") }],
    );
    expect(body.personalizations[0]).toEqual({
      to: [{ email: "grace@example.org" }],
      cc: undefined,
      bcc: [{ email: "audit@example.com" }],
      custom_args: { thread: "t1" },
    });
    expect(body.from).toEqual({ email: "ada@example.com", name: "Ada" });
    expect(body.reply_to_list).toEqual([{ email: "support@example.com" }]);
    expect(body.content).toEqual([
      { type: "text/plain", value: "Hi" },
      { type: "text/html", value: "<p>Hi</p>" },
    ]);
    expect(body.headers).toEqual({ "Message-ID": "<abc@hellobox.app>", "In-Reply-To": "<prev@example.org>" });
    expect(body.attachments).toEqual([{ content: "aGV5", filename: "a.txt", type: "text/plain", disposition: "attachment" }]);
  });

  test("an empty body still sends", () => {
    const body = sendgridMailBody({ from: "ada@example.com", to: ["grace@example.org"], subject: "Hi", html: "" }, []);
    expect(body.content).toEqual([{ type: "text/plain", value: " " }]);
  });
});

describe("events", () => {
  test("names the message by the id the send returned", () => {
    expect(sendgridMessageId({ sg_message_id: "14c5d75ce93.dfd.64b469.filter0001.16648.5515E0B88.0" })).toBe("14c5d75ce93.dfd.64b469");
    expect(sendgridMessageId({ sg_message_id: "abc123.recvd-5f7b8c-1-1" })).toBe("abc123");
    expect(sendgridMessageId({ sg_message_id: "abc123" })).toBe("abc123");
    expect(sendgridMessageId({})).toBeNull();
  });

  test("maps events onto delivery statuses", () => {
    expect(sendgridDeliveryType({ event: "delivered" })).toBe("email.delivered");
    expect(sendgridDeliveryType({ event: "bounce", type: "bounce" })).toBe("email.bounced");
    expect(sendgridDeliveryType({ event: "bounce", type: "blocked" })).toBe("email.delivery_delayed");
    expect(sendgridDeliveryType({ event: "deferred" })).toBe("email.delivery_delayed");
    expect(sendgridDeliveryType({ event: "dropped" })).toBe("email.failed");
    expect(sendgridDeliveryType({ event: "spamreport" })).toBe("email.complained");
    expect(sendgridDeliveryType({ event: "open" })).toBeNull();
  });

  test("gives the recipient and the reason", () => {
    expect(sendgridEventDetail({ event: "bounce", email: "Grace@Example.org", reason: "550 no such user" })).toEqual({
      recipients: ["grace@example.org"],
      reason: "550 no such user",
    });
    expect(sendgridEventDetail({ event: "delivered", email: "grace@example.org", response: "250 OK" })).toEqual({
      recipients: ["grace@example.org"],
      reason: undefined,
    });
  });
});

describe("verifySendgridSignature", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const der = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const pem = publicKey.export({ format: "pem", type: "spki" }).toString();
  const body = new TextEncoder().encode('[{"event":"delivered"}]');
  const now = 1_800_000_000_000;
  const timestamp = String(now / 1000);
  const signature = sign("sha256", Buffer.concat([Buffer.from(timestamp), Buffer.from(body)]), privateKey).toString("base64");

  test("takes a signed post, with the key as SendGrid gives it or as PEM", () => {
    expect(verifySendgridSignature(der, { signature, timestamp, body }, now)).toBe(true);
    expect(verifySendgridSignature(pem, { signature, timestamp, body }, now)).toBe(true);
  });

  test("refuses a changed body, a missing signature, an old post and a bad key", () => {
    expect(verifySendgridSignature(der, { signature, timestamp, body: new TextEncoder().encode("[]") }, now)).toBe(false);
    expect(verifySendgridSignature(der, { signature: null, timestamp, body }, now)).toBe(false);
    expect(verifySendgridSignature(der, { signature, timestamp, body }, now + 3_600_000)).toBe(false);
    expect(verifySendgridSignature("not a key", { signature, timestamp, body }, now)).toBe(false);
  });
});

describe("sendgridDomainRecords", () => {
  const domain = {
    id: 1,
    domain: "example.com",
    valid: false,
    dns: {
      mail_cname: { valid: false, type: "cname", host: "em123.example.com", data: "u123.wl.sendgrid.net" },
      dkim1: { valid: false, type: "cname", host: "s1._domainkey.example.com.", data: "s1.domainkey.u123.wl.sendgrid.net" },
      dkim2: { valid: true, type: "cname", host: "s2._domainkey.example.com", data: "s2.domainkey.u123.wl.sendgrid.net" },
    },
  };

  test("lists SendGrid's records, then DMARC and the MX when asked", () => {
    const records = sendgridDomainRecords(domain, { receiving: true, needsDmarc: true });
    expect(records.map((record) => [record.type, record.name])).toEqual([
      ["CNAME", "em123.example.com"],
      ["CNAME", "s1._domainkey.example.com"],
      ["CNAME", "s2._domainkey.example.com"],
      ["TXT", "_dmarc.example.com"],
      ["MX", "example.com"],
    ]);
    expect(records.at(-1)).toMatchObject({ value: "mx.sendgrid.net", priority: 10 });
  });

  test("leaves the MX and DMARC out otherwise", () => {
    expect(sendgridDomainRecords(domain, { receiving: false, needsDmarc: false })).toHaveLength(3);
  });
});
