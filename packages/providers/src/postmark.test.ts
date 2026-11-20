import { describe, expect, test } from "bun:test";
import { parseRawEmail } from "./mime";
import {
  checkBasicAuth,
  isPostmarkAuthError,
  isPostmarkMissingMx,
  PostmarkAccount,
  PostmarkError,
  postmarkDeliveryType,
  postmarkDomainRecords,
  postmarkEventDetail,
  postmarkInboundHint,
  postmarkInboundRaw,
  PostmarkProvider,
  withBasicAuth,
  type PostmarkInbound,
} from "./postmark";

const basic = (value: string) => `Basic ${Buffer.from(value).toString("base64")}`;

describe("checkBasicAuth", () => {
  test("accepts our user with the right password", () => {
    expect(checkBasicAuth(basic("hellobox:s3cret"), "s3cret")).toBe(true);
  });

  test("rejects a wrong password, a wrong user, other schemes and nothing", () => {
    expect(checkBasicAuth(basic("hellobox:nope"), "s3cret")).toBe(false);
    expect(checkBasicAuth(basic("admin:s3cret"), "s3cret")).toBe(false);
    expect(checkBasicAuth("Bearer s3cret", "s3cret")).toBe(false);
    expect(checkBasicAuth(null, "s3cret")).toBe(false);
  });

  test("puts the credentials in the hook URL, encoded", () => {
    expect(withBasicAuth("https://hellobox.app/api/webhooks/postmark/c1/inbound", "a/b+c")).toBe(
      "https://hellobox:a%2Fb+c@hellobox.app/api/webhooks/postmark/c1/inbound",
    );
  });
});

const payload: PostmarkInbound = {
  MessageID: "883953f4-6105-42a2-a16a-77a8eac79483",
  FromFull: { Email: "ada@example.com", Name: "Ada Stone" },
  ToFull: [{ Email: "Support@Acme.com", Name: "" }],
  CcFull: [{ Email: "ops@acme.com", Name: "Ops" }],
  BccFull: [],
  OriginalRecipient: "support@acme.com",
  Subject: "Re: Your receipt",
  Date: "Thu, 5 Nov 2026 16:33:54 +0000",
  TextBody: "Thanks!",
  HtmlBody: "<p>Thanks!</p>",
  Headers: [
    { Name: "Message-ID", Value: "<reply-1@example.com>" },
    { Name: "In-Reply-To", Value: "<sent-1@acme.com>" },
    { Name: "References", Value: "<sent-1@acme.com>" },
    { Name: "X-Spam-Score", Value: "-0.1" },
  ],
  Attachments: [
    { Name: "notes.txt", Content: Buffer.from("hello").toString("base64"), ContentType: "text/plain", ContentLength: 5 },
    { Name: "logo.png", Content: Buffer.from("png").toString("base64"), ContentType: "image/png", ContentID: "logo@acme" },
  ],
};

describe("postmarkInboundRaw", () => {
  test("uses RawEmail as it is when Postmark sends it", async () => {
    const raw = "From: a@example.com\r\nSubject: Raw\r\n\r\nBody";
    expect(new TextDecoder().decode(await postmarkInboundRaw({ ...payload, RawEmail: raw }))).toBe(raw);
  });

  test("rebuilds a message that keeps threading headers, bodies and attachments", async () => {
    const email = await parseRawEmail("id", await postmarkInboundRaw(payload), postmarkInboundHint(payload));
    expect(email.from).toBe('"Ada Stone" <ada@example.com>');
    // The composer lowercases domains, which addresses ignore anyway.
    expect(email.to).toEqual(["Support@acme.com"]);
    expect(email.cc).toEqual(['"Ops" <ops@acme.com>']);
    expect(email.subject).toBe("Re: Your receipt");
    expect(email.messageId).toBe("<reply-1@example.com>");
    expect(email.headers["in-reply-to"]).toBe("<sent-1@acme.com>");
    expect(email.headers["x-spam-score"]).toBe("-0.1");
    expect(email.text?.trim()).toBe("Thanks!");
    expect(email.html).toContain("<p>Thanks!</p>");
    // Inline images move into the related part, so the order can change.
    const byName = [...email.attachments].sort((a, b) => a.filename.localeCompare(b.filename));
    expect(byName.map((a) => [a.filename, a.contentType, a.contentId])).toEqual([
      ["logo.png", "image/png", "logo@acme"],
      ["notes.txt", "text/plain", null],
    ]);
    const bytes = await new Response(await byName[1]!.open()).text();
    expect(bytes).toBe("hello");
  });
});

describe("postmarkInboundHint", () => {
  test("collects every recipient once, lowercased", () => {
    expect(postmarkInboundHint(payload).recipients).toEqual(["support@acme.com", "ops@acme.com"]);
  });
});

describe("postmarkDeliveryType", () => {
  test("maps deliveries, hard and soft bounces and complaints", () => {
    expect(postmarkDeliveryType({ RecordType: "Delivery" })).toBe("email.delivered");
    expect(postmarkDeliveryType({ RecordType: "Bounce", Type: "HardBounce" })).toBe("email.bounced");
    expect(postmarkDeliveryType({ RecordType: "Bounce", Type: "Transient" })).toBe("email.delivery_delayed");
    expect(postmarkDeliveryType({ RecordType: "SpamComplaint" })).toBe("email.complained");
  });

  test("ignores what the inbox doesn't show", () => {
    expect(postmarkDeliveryType({ RecordType: "Bounce", Type: "AutoResponder" })).toBeNull();
    expect(postmarkDeliveryType({ RecordType: "Open" })).toBeNull();
    expect(postmarkDeliveryType({})).toBeNull();
  });
});

const details = {
  ID: 7,
  Name: "Acme.com",
  DKIMVerified: false,
  ReturnPathDomainVerified: false,
  DKIMHost: "",
  DKIMTextValue: "",
  DKIMPendingHost: "20261111pm._domainkey.acme.com",
  DKIMPendingTextValue: "k=rsa; p=MIGf",
  ReturnPathDomain: "pm-bounces.acme.com",
  ReturnPathDomainCNAMEValue: "pm.mtasv.net",
};

describe("postmarkDomainRecords", () => {
  test("lists the pending DKIM key, the Return-Path, DMARC and the MX when receiving", () => {
    const records = postmarkDomainRecords(details, { receiving: true, needsDmarc: true });
    expect(records.map((r) => [r.type, r.name, r.value])).toEqual([
      ["TXT", "20261111pm._domainkey.acme.com", "k=rsa; p=MIGf"],
      ["CNAME", "pm-bounces.acme.com", "pm.mtasv.net"],
      ["TXT", "_dmarc.acme.com", "v=DMARC1; p=none;"],
      ["MX", "acme.com", "inbound.postmarkapp.com"],
    ]);
    expect(records.at(-1)).toMatchObject({ priority: 10, keepExisting: true });
  });

  test("uses the live DKIM key once verified, and skips what isn't needed", () => {
    const verified = { ...details, DKIMVerified: true, DKIMPendingHost: "", DKIMPendingTextValue: "", DKIMHost: "live._domainkey.acme.com", DKIMTextValue: "k=rsa; p=LIVE" };
    const records = postmarkDomainRecords(verified, { receiving: false, needsDmarc: false });
    expect(records.map((r) => r.name)).toEqual(["live._domainkey.acme.com", "pm-bounces.acme.com"]);
  });
});

function fakeFetch(routes: Record<string, (body: unknown) => [number, unknown]>) {
  const calls: { method: string; path: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = url.replace("https://api.postmarkapp.com", "");
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method ?? "GET", path, headers: init.headers as Record<string, string>, body });
    const route = routes[`${init.method} ${path}`];
    const [status, json] = route ? route(body) : [404, { ErrorCode: 0, Message: "Not found" }];
    return new Response(JSON.stringify(json), { status });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

describe("Postmark API", () => {
  test("sends the account token, and marks a 401 as an auth error", async () => {
    const { calls, fetcher } = fakeFetch({ "GET /servers?count=500&offset=0": () => [401, { ErrorCode: 10, Message: "Bad token" }] });
    const error = await new PostmarkAccount("tok", fetcher).listServers().catch((caught) => caught);
    expect(calls[0]?.headers["X-Postmark-Account-Token"]).toBe("tok");
    expect(error.message).toBe("Bad token");
    expect(isPostmarkAuthError(error)).toBe(true);
  });

  test("sends on the outbound stream with our headers, and returns Postmark's id", async () => {
    const { calls, fetcher } = fakeFetch({ "POST /email": () => [200, { MessageID: "pm-1", ErrorCode: 0 }] });
    const provider = new PostmarkProvider(
      { workspaceId: "w", connectionId: "c", accountToken: "a", serverToken: "s", serverId: 1 },
      fetcher,
    );
    const sent = await provider.send({
      from: "Acme <support@acme.com>",
      to: ["ada@example.com"],
      replyTo: ["Acme <support@acme.com>"],
      subject: "Hi",
      html: "<p>Hi</p>",
      headers: { "Message-ID": "<m1@acme.com>", "In-Reply-To": "<r0@example.com>" },
      tags: { campaign: "c1" },
    });
    expect(sent).toEqual({ id: "pm-1" });
    expect(calls[0]?.headers["X-Postmark-Server-Token"]).toBe("s");
    expect(calls[0]?.body).toMatchObject({
      From: "Acme <support@acme.com>",
      To: "ada@example.com",
      ReplyTo: "support@acme.com",
      MessageStream: "outbound",
      Metadata: { campaign: "c1" },
      Headers: [
        { Name: "Message-ID", Value: "<m1@acme.com>" },
        { Name: "In-Reply-To", Value: "<r0@example.com>" },
      ],
    });
  });

  test("marks the server's one inbound domain as receiving", async () => {
    const { fetcher } = fakeFetch({
      "GET /domains?count=500&offset=0": () => [200, {
        TotalCount: 2,
        Domains: [
          { ID: 1, Name: "Acme.com", DKIMVerified: true, ReturnPathDomainVerified: true },
          { ID: 2, Name: "other.io", DKIMVerified: false, ReturnPathDomainVerified: false },
        ],
      }],
    });
    const provider = new PostmarkProvider(
      { workspaceId: "w", connectionId: "c", accountToken: "a", serverToken: "s", serverId: 1, inboundDomain: "acme.com" },
      fetcher,
    );
    expect(await provider.listDomains()).toEqual([
      { id: "1", name: "acme.com", status: "verified", sending: true, receiving: true },
      { id: "2", name: "other.io", status: "pending", sending: false, receiving: false },
    ]);
  });
});

describe("postmarkEventDetail", () => {
  test("names the bounced recipient and Postmark's description", () => {
    expect(postmarkEventDetail({ RecordType: "Bounce", Type: "HardBounce", Email: "Ada@Example.com", Description: "Unknown user" }))
      .toEqual({ recipients: ["ada@example.com"], reason: "Unknown user" });
    expect(postmarkEventDetail({ RecordType: "Delivery", Recipient: "bo@example.com", Details: "250 OK" }))
      .toEqual({ recipients: ["bo@example.com"], reason: undefined });
  });
});

describe("isPostmarkMissingMx", () => {
  test("spots Postmark refusing an inbound domain without its MX", () => {
    const missing = new PostmarkError("We could not find an MX record pointing to inbound.postmarkapp.com for this domain.", 422, 400);
    expect(isPostmarkMissingMx(missing)).toBe(true);
  });

  test("leaves other errors alone", () => {
    expect(isPostmarkMissingMx(new PostmarkError("Inbound domain is already in use", 422, 400))).toBe(false);
    expect(isPostmarkMissingMx(new PostmarkError("MX", 401, 10))).toBe(false);
    expect(isPostmarkMissingMx(new Error("MX record missing"))).toBe(false);
  });
});
