import { describe, expect, test } from "bun:test";
import { dmarcRecord, keepsExisting, txtTag } from "./dns";
import { inboundMxRecord } from "./ses/provider";

describe("keepsExisting", () => {
  const mx = inboundMxRecord("example.com", "eu-west-1");

  test("leaves an MX that points somewhere else", () => {
    expect(keepsExisting(mx, ["10 aspmx.l.google.com"])).toBe(true);
  });

  test("writes an MX when there's none, or it's already ours", () => {
    expect(keepsExisting(mx, [])).toBe(false);
    expect(keepsExisting(mx, ["10 inbound-smtp.eu-west-1.amazonaws.com"])).toBe(false);
  });

  test("keeps a DMARC policy the domain already has", () => {
    expect(keepsExisting(dmarcRecord("example.com"), ['"v=DMARC1; p=reject;"'])).toBe(true);
    expect(keepsExisting(dmarcRecord("example.com"), ["v=DMARC1; p=none;"])).toBe(false);
  });

  test("ignores other TXT records at the same name", () => {
    expect(keepsExisting(dmarcRecord("example.com"), ["google-site-verification=abc"])).toBe(false);
  });

  test("never holds back records that don't ask to", () => {
    const spf = { type: "TXT" as const, name: "bounce.example.com", value: "v=spf1 include:amazonses.com ~all", purpose: "" };
    expect(keepsExisting(spf, ["v=spf1 -all"])).toBe(false);
  });
});

test("txtTag reads the record's kind", () => {
  expect(txtTag('"v=spf1 include:amazonses.com ~all"')).toBe("v=spf1");
  expect(txtTag("v=DMARC1; p=none;")).toBe("v=DMARC1");
});
