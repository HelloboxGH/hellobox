import { describe, expect, test } from "bun:test";
import {
  BrevoProvider,
  brevoAddress,
  brevoDeliveryType,
  brevoDomainRecords,
  brevoEventDetail,
  brevoInboundHint,
  brevoInboundRaw,
  brevoMailBody,
  isBrevoAuthError,
} from "./brevo";
import { parseRawEmail } from "./mime";

const message = {
  from: "Ada <ada@example.com>",
  to: ["grace@example.org"],
  cc: ["Linus <linus@example.net>"],
  bcc: ["audit@example.com"],
  replyTo: ["support@example.com", "other@example.com"],
  subject: "Re: Hello",
  html: "<p>Hi</p>",
  text: "Hi",
  headers: { "Message-ID": "<abc@hellobox.app>", "In-Reply-To": "<prev@example.org>", References: "<prev@example.org>" },
  tags: { thread: "t1" },
};

describe("brevoMailBody", () => {
  test("leaves our Message-ID to Brevo and keeps the threading headers", () => {
    const body = brevoMailBody(message, [{ filename: "a.txt", content: new TextEncoder().encode("hey") }]);
    expect(body.sender).toEqual({ email: "ada@example.com", name: "Ada" });
    expect(body.cc).toEqual([{ email: "linus@example.net", name: "Linus" }]);
    expect(body.bcc).toEqual([{ email: "audit@example.com" }]);
    expect(body.replyTo).toEqual({ email: "support@example.com" });
    expect(body.headers).toEqual({ "In-Reply-To": "<prev@example.org>", References: "<prev@example.org>" });
    expect(body.tags).toEqual(["thread:t1"]);
    expect(body.attachment).toEqual([{ name: "a.txt", content: "aGV5" }]);
  });

  test("can leave the threading headers out", () => {
    expect(brevoMailBody(message, [], { threading: false }).headers).toBeUndefined();
  });

  test("an empty body still sends", () => {
    const body = brevoMailBody({ from: "ada@example.com", to: ["grace@example.org"], subject: "Hi", html: "" }, []);
    expect(body.textContent).toBe(" ");
    expect(body.htmlContent).toBeUndefined();
  });

  test("names are cut to Brevo's 70 characters", () => {
    expect(brevoAddress(`${"a".repeat(80)} <a@example.com>`).name).toHaveLength(70);
  });
});

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

const target = { workspaceId: "w1", connectionId: "c1", apiKey: "xkeysib-test", inbound: { "reply.example.com": "7" } };

describe("BrevoProvider", () => {
  test("returns Brevo's Message-ID, so events match and replies thread", async () => {
    const fake = fakeFetch({ "POST /v3/smtp/email": () => Response.json({ messageId: "<2019.578@smtp-relay.mailin.fr>" }, { status: 201 }) });
    const sent = await new BrevoProvider(target, fake.fetcher).send({ ...message, attachments: [] });
    expect(sent).toEqual({ id: "2019.578@smtp-relay.mailin.fr", messageIdHeader: "<2019.578@smtp-relay.mailin.fr>" });
  });

  test("sends again without the threading headers if Brevo refuses them", async () => {
    let tries = 0;
    const fake = fakeFetch({
      "POST /v3/smtp/email": () =>
        ++tries === 1
          ? Response.json({ code: "invalid_parameter", message: "Standard header In-Reply-To is not supported" }, { status: 400 })
          : Response.json({ messageId: "<m2@relay>" }, { status: 201 }),
    });
    const sent = await new BrevoProvider(target, fake.fetcher).send({ ...message, attachments: [] });
    expect(sent.id).toBe("m2@relay");
    expect((fake.calls[1]?.body as { headers?: unknown }).headers).toBeUndefined();
  });

  test("a refused key is a reconnect", async () => {
    const fake = fakeFetch({ "GET /v3/account": () => Response.json({ code: "unauthorized", message: "Key not found" }, { status: 401 }) });
    const error = await new BrevoProvider(target, fake.fetcher).account().catch((e: unknown) => e);
    expect(isBrevoAuthError(error)).toBe(true);
  });

  test("lists domains, authenticated ones ready to send", async () => {
    const fake = fakeFetch({
      "GET /v3/senders/domains": () =>
        Response.json({ domains: [
          { domain_name: "Example.com", authenticated: true, verified: true },
          { domain_name: "reply.example.com", authenticated: false, verified: false },
        ] }),
    });
    expect(await new BrevoProvider(target, fake.fetcher).listDomains()).toEqual([
      { id: "example.com", name: "example.com", status: "verified", sending: true, receiving: false },
      { id: "reply.example.com", name: "reply.example.com", status: "pending", sending: false, receiving: true },
    ]);
  });

  test("webhooks carry the token, and disconnecting removes them all", async () => {
    const fake = fakeFetch({ "POST /v3/webhooks": () => Response.json({ id: 9 }, { status: 201 }) });
    const provider = new BrevoProvider(target, fake.fetcher);
    expect(await provider.createInboundWebhook("reply.example.com", "https://app/api", "tok")).toBe("9");
    expect(fake.calls[0]?.body).toMatchObject({
      type: "inbound",
      domain: "reply.example.com",
      auth: { type: "bearer", token: "tok" },
      headers: [{ key: "X-HelloBox-Token", value: "tok" }],
    });
    await provider.disconnect("9");
    expect(fake.calls.slice(1).map((call) => `${call.method} ${call.path}`)).toEqual(["DELETE /v3/webhooks/7", "DELETE /v3/webhooks/9"]);
  });
});

describe("events", () => {
  test("maps events onto delivery statuses", () => {
    expect(brevoDeliveryType({ event: "delivered" })).toBe("email.delivered");
    expect(brevoDeliveryType({ event: "hard_bounce" })).toBe("email.bounced");
    expect(brevoDeliveryType({ event: "soft_bounce" })).toBe("email.delivery_delayed");
    expect(brevoDeliveryType({ event: "deferred" })).toBe("email.delivery_delayed");
    expect(brevoDeliveryType({ event: "spam" })).toBe("email.complained");
    expect(brevoDeliveryType({ event: "blocked" })).toBe("email.failed");
    expect(brevoDeliveryType({ event: "invalid_email" })).toBe("email.failed");
    expect(brevoDeliveryType({ event: "opened" })).toBeNull();
  });

  test("gives the recipient and the reason", () => {
    expect(brevoEventDetail({ event: "hard_bounce", email: "Grace@Example.org", reason: "550 no such user" })).toEqual({
      recipients: ["grace@example.org"],
      reason: "550 no such user",
    });
  });
});

describe("brevoDomainRecords", () => {
  const config = {
    domain: "example.com",
    verified: false,
    authenticated: false,
    dns_records: {
      brevo_code: { type: "TXT", host_name: "@", value: "brevo-code:abc", status: false },
      dkim_record: { type: "TXT", host_name: "mail._domainkey", value: "k=rsa;p=MIG", status: false },
      dmarc_record: { type: "TXT", host_name: "_dmarc", value: "v=DMARC1; p=none", status: false },
    },
  };

  test("names records in full, adds our DMARC and both MX records", () => {
    const records = brevoDomainRecords(config, { receiving: true, needsDmarc: true });
    expect(records.map((record) => [record.type, record.name, record.priority])).toEqual([
      ["TXT", "example.com", undefined],
      ["TXT", "mail._domainkey.example.com", undefined],
      ["TXT", "_dmarc.example.com", undefined],
      ["MX", "example.com", 10],
      ["MX", "example.com", 20],
    ]);
  });

  test("leaves DMARC and MX out otherwise", () => {
    expect(brevoDomainRecords(config, { receiving: false, needsDmarc: false })).toHaveLength(2);
  });
});

describe("inbound", () => {
  const item = {
    Uuid: ["u1"],
    MessageId: "<orig@example.org>",
    InReplyTo: "<abc@hellobox.app>",
    From: { Name: "Grace", Address: "grace@example.org" },
    To: [{ Name: null, Address: "Support@acme.com" }],
    Cc: [{ Address: "team@acme.com" }],
    Recipients: ["support@acme.com", "hidden@acme.com"],
    SentAtDate: "Mon, 23 Nov 2026 10:00:00 +0000",
    Subject: "Re: Hello",
    RawHtmlBody: "<p>Thanks</p>",
    RawTextBody: "Thanks",
    Headers: { "Message-ID": "<orig@example.org>", "In-Reply-To": "<abc@hellobox.app>", References: "<abc@hellobox.app>", Received: ["a", "b"] },
    Attachments: [{ Name: "a.txt", ContentType: "text/plain", ContentLength: 3, ContentID: null, DownloadToken: "t1" }],
  };

  test("rebuilds the message with threading and attachments", async () => {
    const raw = await brevoInboundRaw(item, [{ attachment: item.Attachments[0]!, content: new TextEncoder().encode("hey") }]);
    const parsed = await parseRawEmail("x", raw);
    expect(parsed.messageId).toBe("<orig@example.org>");
    expect(parsed.headers["in-reply-to"]).toBe("<abc@hellobox.app>");
    expect(parsed.from).toContain("grace@example.org");
    expect(parsed.subject).toBe("Re: Hello");
    expect(parsed.text?.trim()).toBe("Thanks");
    expect(parsed.attachments.map((file) => file.filename)).toEqual(["a.txt"]);
  });

  test("lists every recipient once, Bcc included", () => {
    expect(brevoInboundHint(item)).toEqual({ recipients: ["support@acme.com", "hidden@acme.com", "team@acme.com"] });
  });
});
