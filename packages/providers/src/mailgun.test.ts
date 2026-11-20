import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  detectMailgunRegion,
  isMailgunAuthError,
  isMailgunUrl,
  MailgunApi,
  mailgunDeliveryType,
  mailgunDomainRecords,
  mailgunEventDetail,
  mailgunInboundId,
  MailgunProvider,
  mailgunRouteAction,
  mailgunRouteExpression,
  mailgunStorageUrl,
  mailgunStoredQuery,
  verifyMailgunSignature,
} from "./mailgun";

const sign = (key: string, timestamp: string, token: string) =>
  createHmac("sha256", key).update(timestamp + token).digest("hex");

describe("verifyMailgunSignature", () => {
  const now = 1_770_920_772_000;
  const timestamp = String(now / 1000);
  const token = "e0b5477167110d68991efc6b9f89f0a11066af27834600e123"; // gitleaks:allow (made-up webhook token)

  test("accepts a fresh signature made with the signing key", () => {
    expect(verifyMailgunSignature({ timestamp, token, signature: sign("key-1", timestamp, token) }, "key-1", now)).toBe(true);
  });

  test("rejects another key, a changed token, and missing parts", () => {
    expect(verifyMailgunSignature({ timestamp, token, signature: sign("other", timestamp, token) }, "key-1", now)).toBe(false);
    expect(verifyMailgunSignature({ timestamp, token: `${token}x`, signature: sign("key-1", timestamp, token) }, "key-1", now)).toBe(false);
    expect(verifyMailgunSignature({ timestamp, token }, "key-1", now)).toBe(false);
    expect(verifyMailgunSignature({ timestamp, token, signature: "not hex" }, "key-1", now)).toBe(false);
  });

  test("rejects signatures older or newer than 15 minutes", () => {
    const old = String(now / 1000 - 16 * 60);
    const future = String(now / 1000 + 16 * 60);
    expect(verifyMailgunSignature({ timestamp: old, token, signature: sign("key-1", old, token) }, "key-1", now)).toBe(false);
    expect(verifyMailgunSignature({ timestamp: future, token, signature: sign("key-1", future, token) }, "key-1", now)).toBe(false);
    const recent = String(now / 1000 - 14 * 60);
    expect(verifyMailgunSignature({ timestamp: recent, token, signature: sign("key-1", recent, token) }, "key-1", now)).toBe(true);
  });
});

describe("routes", () => {
  test("match the domain's addresses in any case, with dots escaped", () => {
    expect(mailgunRouteExpression("reply.acme-1.io")).toBe(
      'match_recipient(".*@[rR][eE][pP][lL][yY]\\.[aA][cC][mM][eE]-1\\.[iI][oO]$")',
    );
    const pattern = new RegExp(mailgunRouteExpression("acme.com").match(/"(.*)"/)![1]!);
    expect(pattern.test("Support@ACME.com")).toBe(true);
    expect(pattern.test("support@acmexcom")).toBe(false);
    expect(pattern.test("support@acme.com.evil.io")).toBe(false);
  });

  test("store the mail and notify our webhook", () => {
    expect(mailgunRouteAction("https://hellobox.app/api/webhooks/mailgun/c1/inbound")).toBe(
      'store(notify="https://hellobox.app/api/webhooks/mailgun/c1/inbound")',
    );
  });
});

describe("inbound ids", () => {
  test("round-trip the storage URL in a key-safe form", () => {
    const url = "https://storage-us-east4.api.mailgun.net/v3/domains/acme.com/messages/BAABAAdzYub9ZBnyVMlI_YnQHR1rCYY1Yg";
    const id = mailgunInboundId(url);
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(id.length).toBeLessThanOrEqual(200);
    expect(mailgunStorageUrl(id)).toBe(url);
  });

  test("only Mailgun's https hosts count as Mailgun URLs", () => {
    expect(isMailgunUrl("https://storage-eu-west1.api.mailgun.net/v3/x")).toBe(true);
    expect(isMailgunUrl("https://api.mailgun.net/v3/routes")).toBe(true);
    expect(isMailgunUrl("http://api.mailgun.net/v3/routes")).toBe(false);
    expect(isMailgunUrl("https://mailgun.net.evil.io/x")).toBe(false);
    expect(isMailgunUrl("https://evilmailgun.net/x")).toBe(false);
    expect(isMailgunUrl("not a url")).toBe(false);
  });
});

describe("mailgunDeliveryType", () => {
  test("maps deliveries, failures by severity and complaints", () => {
    expect(mailgunDeliveryType({ event: "delivered" })).toBe("email.delivered");
    expect(mailgunDeliveryType({ event: "failed", severity: "permanent" })).toBe("email.bounced");
    expect(mailgunDeliveryType({ event: "failed", severity: "temporary" })).toBe("email.delivery_delayed");
    expect(mailgunDeliveryType({ event: "permanent_fail" })).toBe("email.bounced");
    expect(mailgunDeliveryType({ event: "complained" })).toBe("email.complained");
    expect(mailgunDeliveryType({ event: "opened" })).toBeNull();
  });
});

describe("mailgunDomainRecords", () => {
  const details = {
    sending_dns_records: [
      { record_type: "TXT", name: "acme.com", value: "v=spf1 include:mailgun.org ~all", valid: "unknown" },
      { record_type: "TXT", name: "k1._domainkey.acme.com", value: "k=rsa; p=MIGf", valid: "unknown" },
      { record_type: "CNAME", name: "email.acme.com", value: "mailgun.org", valid: "unknown" },
    ],
    receiving_dns_records: [
      { record_type: "MX", value: "mxa.mailgun.org", priority: "10", valid: "unknown" },
      { record_type: "MX", value: "mxb.mailgun.org", priority: "10", valid: "unknown" },
    ],
  };

  test("lists sending records, DMARC and both MX records when receiving", () => {
    const records = mailgunDomainRecords("acme.com", details, { receiving: true, needsDmarc: true });
    expect(records.map((r) => [r.type, r.name, r.value])).toEqual([
      ["TXT", "acme.com", "v=spf1 include:mailgun.org ~all"],
      ["TXT", "k1._domainkey.acme.com", "k=rsa; p=MIGf"],
      ["CNAME", "email.acme.com", "mailgun.org"],
      ["TXT", "_dmarc.acme.com", "v=DMARC1; p=none;"],
      ["MX", "acme.com", "mxa.mailgun.org"],
      ["MX", "acme.com", "mxb.mailgun.org"],
    ]);
    // An SPF record the domain already has is left for the person to merge.
    expect(records[0]?.keepExisting).toBe(true);
    expect(records.at(-1)).toMatchObject({ priority: 10, keepExisting: true });
  });

  test("leaves out MX records when not receiving", () => {
    const records = mailgunDomainRecords("acme.com", details, { receiving: false, needsDmarc: false });
    expect(records.some((r) => r.type === "MX")).toBe(false);
  });
});

describe("mailgunStoredQuery", () => {
  test("asks for stored events on our domains over the last 3 days, newest first", () => {
    const query = mailgunStoredQuery(["acme.com"], new Date("2026-11-11T12:00:00Z"), "tok");
    expect(query).toMatchObject({
      start: "Sun, 08 Nov 2026 12:00:00 GMT",
      end: "Wed, 11 Nov 2026 12:00:00 GMT",
      events: ["stored"],
      pagination: { sort: "timestamp:desc", limit: 100, token: "tok" },
    });
    expect(query.filter.AND[0]?.values).toEqual([{ label: "acme.com", value: "acme.com" }]);
  });
});

function fakeFetch(handler: (url: string, init: RequestInit) => [number, unknown]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const [status, json] = handler(url, init);
    return new Response(JSON.stringify(json), { status });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

describe("Mailgun API", () => {
  test("uses basic auth with the api user, and marks a 401 as an auth error", async () => {
    const { calls, fetcher } = fakeFetch(() => [401, { message: "Forbidden" }]);
    const error = await new MailgunApi("key-1", "eu", fetcher).listDomains().catch((caught) => caught);
    expect(calls[0]?.url).toBe("https://api.eu.mailgun.net/v4/domains?limit=1000&skip=0");
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("api:key-1").toString("base64")}`);
    expect(isMailgunAuthError(error)).toBe(true);
  });

  test("never sends the key to a host outside mailgun.net", async () => {
    const { calls, fetcher } = fakeFetch(() => [200, {}]);
    await expect(new MailgunApi("key-1", "us", fetcher).call("GET", "https://evil.example/steal")).rejects.toThrow("outside mailgun.net");
    expect(calls).toHaveLength(0);
  });

  test("detects the region that has domains, and can't tell when both or neither do", async () => {
    const domainsIn = (us: number, eu: number) =>
      fakeFetch((url) => [200, { total_count: url.includes(".eu.") ? eu : us, items: Array.from({ length: url.includes(".eu.") ? eu : us }, (_, i) => ({ name: `d${i}.io`, state: "active" })) }]).fetcher;
    expect(await detectMailgunRegion("k", domainsIn(0, 2))).toBe("eu");
    expect(await detectMailgunRegion("k", domainsIn(3, 0))).toBe("us");
    expect(await detectMailgunRegion("k", domainsIn(1, 1))).toBeNull();
    expect(await detectMailgunRegion("k", domainsIn(0, 0))).toBeNull();
  });

  test("a key refused in both regions is an error, not a question", async () => {
    const { fetcher } = fakeFetch(() => [401, { message: "Forbidden" }]);
    const error = await detectMailgunRegion("bad", fetcher).catch((caught) => caught);
    expect(isMailgunAuthError(error)).toBe(true);
  });

  test("sends our own MIME to every recipient, and strips brackets from the id", async () => {
    const { calls, fetcher } = fakeFetch(() => [200, { id: "<m1@acme.com>", message: "Queued. Thank you." }]);
    const provider = new MailgunProvider({ workspaceId: "w", connectionId: "c", apiKey: "k", region: "us", routes: {} }, fetcher);
    const sent = await provider.send({
      from: "Acme <support@acme.com>",
      to: ["Ada <ada@example.com>"],
      cc: ["ops@example.com"],
      bcc: ["audit@acme.com"],
      subject: "Hi",
      html: "<p>Hi</p>",
      headers: { "Message-ID": "<m1@acme.com>", "In-Reply-To": "<r0@example.com>" },
    });
    expect(sent).toEqual({ id: "m1@acme.com" });
    expect(calls[0]?.url).toBe("https://api.mailgun.net/v3/acme.com/messages.mime");
    const form = calls[0]?.init.body as FormData;
    expect(form.getAll("to")).toEqual(["ada@example.com", "ops@example.com", "audit@acme.com"]);
    const mime = await (form.get("message") as Blob).text();
    expect(mime).toContain("Message-ID: <m1@acme.com>");
    expect(mime).toContain("In-Reply-To: <r0@example.com>");
    // Bcc stays out of the headers.
    expect(mime).not.toContain("audit@acme.com");
  });

  test("lists domains without sandboxes, receiving where we have a route", async () => {
    const { fetcher } = fakeFetch(() => [200, {
      total_count: 3,
      items: [
        { name: "Acme.com", state: "active" },
        { name: "new.io", state: "unverified" },
        { name: "sandbox123.mailgun.org", state: "active", type: "sandbox" },
      ],
    }]);
    const provider = new MailgunProvider({ workspaceId: "w", connectionId: "c", apiKey: "k", region: "us", routes: { "acme.com": "r1" } }, fetcher);
    expect(await provider.listDomains()).toEqual([
      { id: "acme.com", name: "acme.com", status: "verified", sending: true, receiving: true },
      { id: "new.io", name: "new.io", status: "pending", sending: false, receiving: false },
    ]);
  });
});

describe("mailgunEventDetail", () => {
  test("names the recipient and the server's message for failures", () => {
    expect(mailgunEventDetail({ event: "failed", severity: "permanent", recipient: "Ada@Example.com", "delivery-status": { message: "550 No such user" } }))
      .toEqual({ recipients: ["ada@example.com"], reason: "550 No such user" });
    expect(mailgunEventDetail({ event: "delivered", recipient: "bo@example.com", "delivery-status": { message: "OK" } }))
      .toEqual({ recipients: ["bo@example.com"], reason: undefined });
  });
});
