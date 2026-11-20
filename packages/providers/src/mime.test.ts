import { describe, expect, test } from "bun:test";
import { buildRawEmail, parseAuthenticationResults, parseRawEmail } from "./mime";

const RAW = [
  "Authentication-Results: amazonses.com; spf=pass smtp.mailfrom=example.com; dkim=pass header.i=@example.com; dmarc=fail header.from=example.com;",
  'From: "Ada Lovelace" <ada@example.com>',
  "To: hello@acme.test, Team: bob@acme.test, carol@acme.test;",
  "Cc: dave@acme.test",
  "Reply-To: replies@example.com",
  "Subject: =?UTF-8?Q?Caf=C3=A9_plans?=",
  "Message-ID: <abc@example.com>",
  "In-Reply-To: <parent@acme.test>",
  "References: <root@acme.test> <parent@acme.test>",
  "Date: Sun, 08 Nov 2026 10:00:00 +0000",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="b1"',
  "",
  "--b1",
  'Content-Type: multipart/alternative; boundary="b2"',
  "",
  "--b2",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Hello there",
  "--b2",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<p>Hello <img src=\"cid:logo@acme\"></p>",
  "--b2--",
  "--b1",
  "Content-Type: image/png",
  "Content-Disposition: inline",
  "Content-ID: <logo@acme>",
  "Content-Transfer-Encoding: base64",
  "",
  "iVBORw0KGgo=",
  "--b1",
  'Content-Type: application/pdf; name="plan.pdf"',
  'Content-Disposition: attachment; filename="plan.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  "JVBERi0xLjQ=",
  "--b1--",
  "",
].join("\r\n");

describe("parseRawEmail", () => {
  test("reads addresses, threading headers, bodies and attachments", async () => {
    const email = await parseRawEmail("id-1", new TextEncoder().encode(RAW), { recipients: ["hello@acme.test"] });
    expect(email.from).toBe('"Ada Lovelace" <ada@example.com>');
    expect(email.to).toEqual(["hello@acme.test", "bob@acme.test", "carol@acme.test"]);
    expect(email.cc).toEqual(["dave@acme.test"]);
    expect(email.replyTo).toEqual(["replies@example.com"]);
    expect(email.recipients).toEqual(["hello@acme.test"]);
    expect(email.subject).toBe("Café plans");
    expect(email.messageId).toBe("<abc@example.com>");
    expect(email.headers["in-reply-to"]).toBe("<parent@acme.test>");
    expect(email.headers.references).toBe("<root@acme.test> <parent@acme.test>");
    expect(email.text?.trim()).toBe("Hello there");
    expect(email.html).toContain("cid:logo@acme");
    expect(email.sentAt.toISOString()).toBe("2026-11-08T10:00:00.000Z");
    expect(email.authentication).toEqual({ spf: "pass", dkim: "pass", dmarc: "fail" });
    expect(email.attachments.map((a) => [a.filename, a.contentType, a.contentId, a.disposition])).toEqual([
      ["attachment", "image/png", "logo@acme", "inline"],
      ["plan.pdf", "application/pdf", null, "attachment"],
    ]);
    const pdf = new Uint8Array(await new Response(await email.attachments[1]!.open()).arrayBuffer());
    expect(new TextDecoder().decode(pdf)).toBe("%PDF-1.4");
    const raw = new Uint8Array(await new Response(await email.raw!.open()).arrayBuffer());
    expect(raw.length).toBe(RAW.length);
  });

  test("prefers authentication results from the envelope", async () => {
    const email = await parseRawEmail("id-2", new TextEncoder().encode(RAW), {
      authentication: { spf: "fail" },
    });
    expect(email.authentication).toEqual({ spf: "fail" });
  });
});

describe("parseAuthenticationResults", () => {
  test("returns null without results", () => {
    expect(parseAuthenticationResults(undefined)).toBeNull();
    expect(parseAuthenticationResults("example.com; none")).toBeNull();
  });
});

describe("buildRawEmail", () => {
  test("round-trips through the parser and keeps Bcc out of the headers", async () => {
    const raw = await buildRawEmail(
      {
        from: "Acme <hello@acme.test>",
        to: ["ada@example.com"],
        cc: ["bob@example.com"],
        bcc: ["secret@example.com"],
        subject: "Re: Café plans",
        html: "<p>Sounds good</p>",
        headers: {
          "Message-ID": "<out-1@acme.test>",
          "In-Reply-To": "<abc@example.com>",
          References: "<abc@example.com>",
        },
      },
      [{ filename: "notes.txt", contentType: "text/plain", content: new TextEncoder().encode("hi") }],
    );
    const text = new TextDecoder().decode(raw);
    expect(text).not.toContain("secret@example.com");
    const parsed = await parseRawEmail("x", raw);
    expect(parsed.from).toBe('"Acme" <hello@acme.test>');
    expect(parsed.cc).toEqual(["bob@example.com"]);
    expect(parsed.subject).toBe("Re: Café plans");
    expect(parsed.messageId).toBe("<out-1@acme.test>");
    expect(parsed.headers["in-reply-to"]).toBe("<abc@example.com>");
    expect(parsed.html).toContain("Sounds good");
    expect(parsed.attachments[0]?.filename).toBe("notes.txt");
  });
});
