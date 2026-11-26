import { describe, expect, test } from "bun:test";
import { resendDomainRecords, resendHeaders, resendRecordName } from "./resend";

describe("resendRecordName", () => {
  test("relative names sit under the domain", () => {
    expect(resendRecordName("send", "acme.com")).toBe("send.acme.com");
    expect(resendRecordName("resend._domainkey", "acme.com")).toBe("resend._domainkey.acme.com");
    expect(resendRecordName("@", "acme.com")).toBe("acme.com");
  });

  test("a subdomain's names relative to its parent aren't doubled", () => {
    expect(resendRecordName("send.reply", "reply.acme.com")).toBe("send.reply.acme.com");
    expect(resendRecordName("resend._domainkey.reply", "reply.acme.com")).toBe("resend._domainkey.reply.acme.com");
    expect(resendRecordName("reply", "reply.acme.com")).toBe("reply.acme.com");
  });

  test("names relative to the subdomain itself, and full names, work too", () => {
    expect(resendRecordName("send", "reply.acme.com")).toBe("send.reply.acme.com");
    expect(resendRecordName("links.reply.acme.com", "reply.acme.com")).toBe("links.reply.acme.com");
  });
});

describe("resendDomainRecords", () => {
  const records = [
    { record: "DKIM", name: "resend._domainkey.reply", type: "TXT", value: "p=abc" },
    { record: "SPF", name: "send.reply", type: "MX", value: "feedback-smtp.us-east-1.amazonses.com", priority: 10 },
    { record: "SPF", name: "send.reply", type: "TXT", value: "\"v=spf1 include:amazonses.com ~all\"" },
    { record: "Receiving", name: "reply", type: "MX", value: "inbound-smtp.us-east-1.amazonaws.com", priority: 10 },
  ];

  test("only the MX on the domain itself receives, and it never replaces another", () => {
    const result = resendDomainRecords("reply.acme.com", records, { needsDmarc: false });
    const mx = result.filter((record) => record.type === "MX");
    expect(mx.map((record) => [record.name, Boolean(record.keepExisting)])).toEqual([
      ["send.reply.acme.com", false],
      ["reply.acme.com", true],
    ]);
    expect(result.find((record) => record.type === "TXT" && record.name === "send.reply.acme.com")?.value).toBe(
      "v=spf1 include:amazonses.com ~all",
    );
  });

  test("adds DMARC when the domain has none", () => {
    expect(resendDomainRecords("reply.acme.com", records, { needsDmarc: true }).at(-1)?.name).toBe("_dmarc.reply.acme.com");
  });
});

describe("resendHeaders", () => {
  test("puts our Message-ID in References, which SES leaves alone", () => {
    expect(resendHeaders({ "Message-ID": "<m2@a.test>" })).toEqual({ "Message-ID": "<m2@a.test>", References: "<m2@a.test>" });
    expect(resendHeaders({ "Message-ID": "<m2@a.test>", "In-Reply-To": "<m1@b.test>", References: "<m0@a.test> <m1@b.test>" })).toEqual({
      "Message-ID": "<m2@a.test>", "In-Reply-To": "<m1@b.test>", References: "<m0@a.test> <m1@b.test> <m2@a.test>",
    });
    expect(resendHeaders({ "Message-ID": "<m2@a.test>", References: "<m2@a.test>" })).toEqual({ "Message-ID": "<m2@a.test>", References: "<m2@a.test>" });
    expect(resendHeaders({ "X-Other": "1" })).toEqual({ "X-Other": "1" });
    expect(resendHeaders(undefined)).toBeUndefined();
  });
});
