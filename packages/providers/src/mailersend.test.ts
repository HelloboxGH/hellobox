import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  isMailersendAuthError,
  MailersendProvider,
  mailersendDeliveryType,
  mailersendDomainRecords,
  mailersendEventDetail,
  mailersendInboundHint,
  mailersendInboundRaw,
  mailersendMailBody,
  verifyMailersendSignature,
} from "./mailersend";
import { parseRawEmail } from "./mime";

const message = {
  from: "Ada <ada@example.com>",
  to: ["grace@example.org"],
  bcc: ["audit@example.com"],
  replyTo: ["support@example.com"],
  subject: "Re: Hello",
  html: "<p>Hi</p>",
  text: "Hi",
  headers: { "Message-ID": "<abc@hellobox.app>", "In-Reply-To": "<prev@example.org>", References: "<first@example.org> <prev@example.org>" },
  tags: { thread: "t1" },
};

function fakeFetch(answers: Record<string, () => Response>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push({ method: init.method ?? "GET", path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const answer = answers[`${init.method} ${path}`];
    return answer ? answer() : new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

const target = { workspaceId: "w1", connectionId: "c1", apiKey: "mlsn.test", inbound: {} };

describe("mailersendMailBody", () => {
  test("threads with MailerSend's own fields", () => {
    const body = mailersendMailBody(message, [{ filename: "logo.png", contentId: "logo", content: new Uint8Array([1]) }]);
    expect(body.from).toEqual({ email: "ada@example.com", name: "Ada" });
    expect(body.reply_to).toEqual({ email: "support@example.com" });
    expect(body.in_reply_to).toBe("<prev@example.org>");
    expect(body.references).toEqual(["<first@example.org>", "<prev@example.org>"]);
    expect(body.tags).toEqual(["thread:t1"]);
    expect(body.attachments).toEqual([{ content: "AQ==", filename: "logo.png", disposition: "inline", id: "logo" }]);
    expect(JSON.stringify(body)).not.toContain("abc@hellobox.app");
  });

  test("can leave threading out", () => {
    const body = mailersendMailBody(message, [], { threading: false });
    expect(body.in_reply_to).toBeUndefined();
    expect(body.references).toBeUndefined();
  });
});

describe("MailersendProvider", () => {
  test("returns the id events name the message by", async () => {
    const fake = fakeFetch({ "POST /v1/email": () => new Response(null, { status: 202, headers: { "x-message-id": "5e42957d" } }) });
    expect(await new MailersendProvider(target, fake.fetcher).send({ ...message, attachments: [] })).toEqual({ id: "5e42957d" });
  });

  test("sends again without threading if the plan doesn't allow it", async () => {
    let tries = 0;
    const fake = fakeFetch({
      "POST /v1/email": () =>
        ++tries === 1
          ? Response.json({ message: "The given data was invalid.", errors: { in_reply_to: ["The in reply to field is not allowed on your plan. #MS42234"] } }, { status: 422 })
          : new Response(null, { status: 202, headers: { "x-message-id": "m2" } }),
    });
    expect((await new MailersendProvider(target, fake.fetcher).send({ ...message, attachments: [] })).id).toBe("m2");
    expect((fake.calls[1]?.body as { in_reply_to?: string }).in_reply_to).toBeUndefined();
  });

  test("a refused token is a reconnect", async () => {
    const fake = fakeFetch({ "GET /v1/domains": () => Response.json({ message: "Unauthenticated." }, { status: 401 }) });
    expect(isMailersendAuthError(await new MailersendProvider(target, fake.fetcher).allDomains().catch((e: unknown) => e))).toBe(true);
  });

  test("a catch-all route for the domain, posting to us, with the MX MailerSend wants", async () => {
    const fake = fakeFetch({
      "GET /v1/domains": () => Response.json({ data: [{ id: "d1", name: "example.com", is_verified: true }], meta: { last_page: 1 } }),
      "POST /v1/inbound": () => Response.json({ data: { id: "r1", mxValues: { priority: 10, target: "inbound.mailersend.net." } } }, { status: 201 }),
    });
    expect(await new MailersendProvider(target, fake.fetcher).createRoute("example.com", "https://app/in")).toEqual({
      routeId: "r1",
      mx: "inbound.mailersend.net",
    });
    expect(fake.calls[1]?.body).toMatchObject({
      domain_id: "d1",
      inbound_domain: "example.com",
      catch_filter: { type: "catch_all" },
      forwards: [{ type: "webhook", value: "https://app/in" }],
    });
  });
});

describe("events", () => {
  test("maps events onto delivery statuses", () => {
    expect(mailersendDeliveryType({ type: "activity.delivered" })).toBe("email.delivered");
    expect(mailersendDeliveryType({ type: "activity.hard_bounced" })).toBe("email.bounced");
    expect(mailersendDeliveryType({ type: "activity.soft_bounced" })).toBe("email.delivery_delayed");
    expect(mailersendDeliveryType({ type: "activity.spam_complaint" })).toBe("email.complained");
    expect(mailersendDeliveryType({ type: "activity.opened" })).toBeNull();
  });

  test("gives the recipient and the bounce reason", () => {
    expect(
      mailersendEventDetail({ type: "activity.hard_bounced", data: { recipient: "Grace@Example.org", meta: { bounce_reason: "550 no such user" } } }),
    ).toEqual({ recipients: ["grace@example.org"], reason: "550 no such user" });
    expect(mailersendEventDetail({ type: "activity.delivered", data: { recipient: "g@example.org", meta: [] } }).reason).toBeUndefined();
  });

  test("checks the signature over the body", () => {
    const body = new TextEncoder().encode('{"type":"activity.delivered"}');
    const signature = createHmac("sha256", "secret").update(body).digest("hex");
    expect(verifyMailersendSignature("secret", signature, body)).toBe(true);
    expect(verifyMailersendSignature("other", signature, body)).toBe(false);
    expect(verifyMailersendSignature("secret", null, body)).toBe(false);
  });
});

describe("mailersendDomainRecords", () => {
  const dns = {
    id: "d1",
    spf: { hostname: "example.com", type: "TXT", value: "v=spf1 include:_spf.mailersend.net -all" },
    dkim_ms1: { hostname: "ms1._domainkey.example.com", type: "CNAME", value: "ms1._domainkey.mailersend.net" },
    dkim_ms2: { hostname: "ms2._domainkey.example.com", type: "CNAME", value: "ms2._domainkey.mailersend.net" },
    dkim: { hostname: null, type: null, value: null },
    return_path: { hostname: "mta.example.com", type: "CNAME", value: "mailersend.net" },
    custom_tracking: { hostname: "email.example.com", type: "CNAME", value: "links.mailersend.net" },
    inbound_routing: { hostname: "inbound.example.com", type: "MX", value: "inbound.mailersend.net", priority: "10" },
  };

  test("lists sending records, then DMARC and our MX, without tracking", () => {
    const records = mailersendDomainRecords("example.com", dns, { receiving: "inbound.mailersend.net", needsDmarc: true });
    expect(records.map((record) => [record.type, record.name])).toEqual([
      ["TXT", "example.com"],
      ["CNAME", "ms1._domainkey.example.com"],
      ["CNAME", "ms2._domainkey.example.com"],
      ["CNAME", "mta.example.com"],
      ["TXT", "_dmarc.example.com"],
      ["MX", "example.com"],
    ]);
    expect(records[0]?.keepExisting).toBe(true);
  });
});

describe("inbound", () => {
  const data = {
    id: "6719d6e0",
    from: { raw: "Grace <grace@example.org>", email: "grace@example.org" },
    recipients: { to: { raw: "support@acme.com", data: [{ email: "Support@acme.com" }] }, rcptTo: [{ email: "hidden@acme.com" }] },
    subject: "Re: Hello",
    date: "Thu, 24 Oct 2024 05:10:42 +0000",
    headers: { "Message-ID": "<orig@example.org>", "In-Reply-To": "<abc@hellobox.app>" },
    text: "Thanks",
    spf_check: { code: "+" },
  };

  test("uses MailerSend's raw copy, as text or base64", async () => {
    const raw = "From: grace@example.org\r\nSubject: Raw\r\n\r\nBody";
    expect(new TextDecoder().decode(await mailersendInboundRaw({ ...data, raw }))).toBe(raw);
    expect(new TextDecoder().decode(await mailersendInboundRaw({ ...data, raw: Buffer.from(raw).toString("base64") }))).toBe(raw);
  });

  test("rebuilds the message, threading kept, when there's no raw copy", async () => {
    const parsed = await parseRawEmail("x", await mailersendInboundRaw(data));
    expect(parsed.messageId).toBe("<orig@example.org>");
    expect(parsed.headers["in-reply-to"]).toBe("<abc@hellobox.app>");
    expect(parsed.subject).toBe("Re: Hello");
  });

  test("gives every recipient and the SPF result", () => {
    expect(mailersendInboundHint(data)).toEqual({ recipients: ["hidden@acme.com", "support@acme.com"], authentication: { spf: "pass" } });
  });
});
