import { describe, expect, test } from "bun:test";
import {
  isMailjetAuthError,
  MailjetProvider,
  mailjetDeliveryType,
  mailjetDomainRecords,
  mailjetEventDetail,
  mailjetEventMessageId,
  mailjetInboundRaw,
  mailjetMessage,
} from "./mailjet";
import { parseRawEmail } from "./mime";

const message = {
  from: "Ada <ada@example.com>",
  to: ["grace@example.org"],
  bcc: ["audit@example.com"],
  replyTo: ["support@example.com"],
  subject: "Re: Hello",
  html: "<p>Hi</p>",
  text: "Hi",
  headers: { "Message-ID": "<abc@hellobox.app>", "In-Reply-To": "<prev@example.org>" },
  tags: { thread: "t1" },
};

function fakeFetch(answers: Record<string, () => Response>) {
  const calls: { method: string; path: string; body: unknown; auth: string | null }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push({
      method: init.method ?? "GET",
      path,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      auth: (init.headers as Record<string, string>).Authorization ?? null,
    });
    const answer = answers[`${init.method} ${path}`];
    return answer ? answer() : Response.json({ Data: [] });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

const target = { workspaceId: "w1", connectionId: "c1", apiKey: "public", secretKey: "private", inbound: {} };

describe("mailjetMessage", () => {
  test("keeps our headers, names the message by CustomID, splits inline files", () => {
    const body = mailjetMessage(message, [
      { filename: "a.txt", contentType: "text/plain", content: new TextEncoder().encode("hey") },
      { filename: "logo.png", contentType: "image/png", contentId: "logo", content: new Uint8Array([1]) },
    ]);
    expect(body.From).toEqual({ Email: "ada@example.com", Name: "Ada" });
    expect(body.ReplyTo).toEqual({ Email: "support@example.com" });
    expect(body.Headers).toEqual({ "Message-ID": "<abc@hellobox.app>", "In-Reply-To": "<prev@example.org>" });
    expect(body.CustomID).toBe("abc@hellobox.app");
    expect(body.EventPayload).toBe('{"thread":"t1"}');
    expect(body.Attachments).toEqual([{ Filename: "a.txt", ContentType: "text/plain", Base64Content: "aGV5" }]);
    expect(body.InlinedAttachments).toEqual([{ Filename: "logo.png", ContentType: "image/png", Base64Content: "AQ==", ContentID: "logo" }]);
  });
});

describe("MailjetProvider", () => {
  test("signs in with both keys and returns the CustomID", async () => {
    const fake = fakeFetch({ "POST /v3.1/send": () => Response.json({ Messages: [{ Status: "success" }] }, { status: 201 }) });
    expect(await new MailjetProvider(target, fake.fetcher).send({ ...message, attachments: [] })).toEqual({ id: "abc@hellobox.app" });
    expect(fake.calls[0]?.auth).toBe(`Basic ${Buffer.from("public:private").toString("base64")}`);
  });

  test("sends again without our headers if Mailjet refuses them", async () => {
    let tries = 0;
    const fake = fakeFetch({
      "POST /v3.1/send": () =>
        ++tries === 1
          ? Response.json({ Messages: [{ Status: "error", Errors: [{ ErrorMessage: "Header Message-ID is reserved" }] }] }, { status: 400 })
          : Response.json({ Messages: [{ Status: "success" }] }, { status: 201 }),
    });
    await new MailjetProvider(target, fake.fetcher).send({ ...message, attachments: [] });
    expect((fake.calls[1]?.body as { Messages: { Headers?: unknown }[] }).Messages[0]?.Headers).toBeUndefined();
  });

  test("wrong keys are a reconnect", async () => {
    const fake = fakeFetch({ "GET /v3/REST/dns": () => new Response("", { status: 401 }) });
    expect(isMailjetAuthError(await new MailjetProvider(target, fake.fetcher).allDns().catch((e: unknown) => e))).toBe(true);
  });

  test("a domain is ready to send once its DKIM checks out", async () => {
    const fake = fakeFetch({
      "GET /v3/REST/dns": () => Response.json({ Data: [{ ID: 1, Domain: "example.com", DKIMStatus: "OK" }, { ID: 2, Domain: "new.example.com", DKIMStatus: "Not checked" }] }),
    });
    expect(await new MailjetProvider(target, fake.fetcher).listDomains()).toEqual([
      { id: "1", name: "example.com", status: "verified", sending: true, receiving: false },
      { id: "2", name: "new.example.com", status: "pending", sending: false, receiving: false },
    ]);
  });

  test("one grouped callback per event type, skipping types already taken", async () => {
    let id = 0;
    const fake = fakeFetch({
      "POST /v3/REST/eventcallbackurl": () =>
        ++id === 2 ? Response.json({ ErrorMessage: "A callback already exists for this event type" }, { status: 400 }) : Response.json({ Data: [{ ID: id }] }, { status: 201 }),
    });
    expect(await new MailjetProvider(target, fake.fetcher).createEventCallbacks("https://app/events?key=k")).toEqual({ ids: ["1", "3", "4"], complete: false });
    expect(fake.calls.map((call) => (call.body as { EventType: string }).EventType)).toEqual(["sent", "bounce", "blocked", "spam"]);
    expect(fake.calls[0]?.body).toMatchObject({ Version: 2 });
  });
});

describe("events", () => {
  test("maps events onto delivery statuses", () => {
    expect(mailjetDeliveryType({ event: "sent" })).toBe("email.delivered");
    expect(mailjetDeliveryType({ event: "bounce", hard_bounce: true })).toBe("email.bounced");
    expect(mailjetDeliveryType({ event: "bounce", hard_bounce: false })).toBe("email.delivery_delayed");
    expect(mailjetDeliveryType({ event: "blocked" })).toBe("email.failed");
    expect(mailjetDeliveryType({ event: "spam" })).toBe("email.complained");
    expect(mailjetDeliveryType({ event: "open" })).toBeNull();
  });

  test("finds the message by CustomID, else MessageID", () => {
    expect(mailjetEventMessageId({ CustomID: "abc@hellobox.app", MessageID: 1 })).toBe("abc@hellobox.app");
    expect(mailjetEventMessageId({ MessageID: 19421777396190490 })).toBe("19421777396190490");
    expect(mailjetEventMessageId({})).toBeNull();
  });

  test("gives the recipient and the reason", () => {
    expect(mailjetEventDetail({ event: "bounce", email: "Grace@Example.org", error: "user unknown", comment: "550 5.1.1" })).toEqual({
      recipients: ["grace@example.org"],
      reason: "user unknown: 550 5.1.1",
    });
  });
});

describe("mailjetDomainRecords", () => {
  const dns = {
    ID: 1,
    Domain: "example.com",
    DKIMRecordName: "mailjet._domainkey.example.com.",
    DKIMRecordValue: "k=rsa; p=MIG",
    SPFRecordValue: "v=spf1 include:spf.mailjet.com ?all",
    OwnerShipToken: "abc123",
    OwnerShipTokenRecordName: "mailjet._abc123",
  };

  test("lists the ownership token, DKIM and SPF, then DMARC and the MX", () => {
    const records = mailjetDomainRecords(dns, { receiving: true, needsDmarc: true });
    expect(records.map((record) => [record.type, record.name, record.value])).toEqual([
      ["TXT", "mailjet._abc123.example.com", "abc123"],
      ["TXT", "mailjet._domainkey.example.com", "k=rsa; p=MIG"],
      ["TXT", "example.com", "v=spf1 include:spf.mailjet.com ?all"],
      ["TXT", "_dmarc.example.com", expect.any(String)],
      ["MX", "example.com", "parse.mailjet.com"],
    ]);
  });
});

describe("mailjetInboundRaw", () => {
  test("rebuilds the message with its headers and base64 attachments", async () => {
    const raw = await mailjetInboundRaw({
      Sender: "grace@example.org",
      Recipient: "support@acme.com",
      Subject: "Re: Hello",
      Headers: {
        From: "Grace <grace@example.org>",
        To: "support@acme.com",
        Subject: "Re: Hello",
        "Message-ID": "<orig@example.org>",
        "In-Reply-To": "<abc@hellobox.app>",
        Received: ["a", "b"],
      },
      Parts: [
        { Headers: { "Content-Type": "text/plain; charset=UTF-8" }, ContentRef: "Text-part" },
        { Headers: { "Content-Type": "text/plain; name=\"a.txt\"", "Content-Disposition": "attachment; filename=\"a.txt\"" }, ContentRef: "Attachment1" },
      ],
      "Text-part": "Thanks",
      Attachment1: Buffer.from("hey").toString("base64"),
    });
    const parsed = await parseRawEmail("x", raw);
    expect(parsed.messageId).toBe("<orig@example.org>");
    expect(parsed.headers["in-reply-to"]).toBe("<abc@hellobox.app>");
    expect(parsed.text?.trim()).toBe("Thanks");
    expect(parsed.attachments.map((file) => file.filename)).toEqual(["a.txt"]);
  });
});
