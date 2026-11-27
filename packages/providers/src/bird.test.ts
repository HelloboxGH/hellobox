import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  BirdProvider,
  birdDeliveryType,
  birdDomainRecords,
  birdInboundHint,
  birdMailBody,
  birdRegionOf,
  detectBirdRegion,
  isBirdAuthError,
  verifyBirdSignature,
} from "./bird";

function fakeFetch(answers: Record<string, () => Response>) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const { origin, pathname } = new URL(url);
    calls.push({ method: init.method ?? "GET", url: `${origin}${pathname}`, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const answer = answers[`${init.method} ${origin}${pathname}`] ?? answers[`${init.method} ${pathname}`];
    return answer ? answer() : Response.json({ data: [], next_cursor: null });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

const target = { apiKey: "bk_us1_test", region: "us1" as const, receiving: [] };
const message = {
  from: "Ada <ada@example.com>",
  to: ["grace@example.org"],
  subject: "Re: Hello",
  html: "<p>Hi</p>",
  headers: { "Message-ID": "<abc@hellobox.app>", "In-Reply-To": "<prev@example.org>" },
};

describe("region", () => {
  test("is read from the key, else tried in turn", async () => {
    expect(birdRegionOf("bk_eu1_abc")).toBe("eu1");
    expect(birdRegionOf("abc")).toBeNull();
    const fake = fakeFetch({ "GET https://us1.platform.bird.com/v1/email/domains": () => new Response("", { status: 421 }) });
    expect(await detectBirdRegion("legacy-key", fake.fetcher)).toBe("eu1");
  });

  test("a refused key finds no region", async () => {
    const fake = fakeFetch({ "GET /v1/email/domains": () => Response.json({ error: { message: "Invalid key" } }, { status: 401 }) });
    expect(await detectBirdRegion("bk_us1_bad", fake.fetcher)).toBeNull();
  });
});

describe("sending", () => {
  test("transactional, untracked, with our headers", () => {
    const body = birdMailBody(message, []);
    expect(body).toMatchObject({ from: "Ada <ada@example.com>", category: "transactional", track_opens: false, track_clicks: false });
    expect(body.headers).toEqual({ "Message-ID": "<abc@hellobox.app>", "In-Reply-To": "<prev@example.org>" });
  });

  test("sends again without Message-ID if Bird keeps it for itself", async () => {
    let tries = 0;
    const fake = fakeFetch({
      "POST /v1/email/messages": () =>
        ++tries === 1
          ? Response.json({ error: { code: "E04099", message: "Header Message-ID is reserved" } }, { status: 422 })
          : Response.json({ id: "em_1", status: "accepted" }, { status: 202 }),
    });
    expect(await new BirdProvider(target, fake.fetcher).send({ ...message, attachments: [] })).toEqual({ id: "em_1" });
    expect((fake.calls[1]?.body as { headers: unknown }).headers).toEqual({ "In-Reply-To": "<prev@example.org>" });
  });

  test("a revoked key is a reconnect", async () => {
    const fake = fakeFetch({ "POST /v1/email/messages": () => Response.json({ error: { message: "Unauthorized" } }, { status: 401 }) });
    expect(isBirdAuthError(await new BirdProvider(target, fake.fetcher).send({ ...message, attachments: [] }).catch((e: unknown) => e))).toBe(true);
  });
});

describe("domains", () => {
  const domain = {
    id: "dom_1",
    domain: "mail.example.com",
    status: "pending",
    receiving: { state: "disabled" },
    dns_records: [
      { type: "TXT" as const, name: "bird1._domainkey.mail", host: "bird1._domainkey.mail.example.com", value: "v=DKIM1; p=MIG", purpose: "dkim" as const, optional: false },
      { type: "CNAME" as const, name: "send.mail", host: "send.mail.example.com", value: "rp.bird.com", purpose: "return_path" as const, optional: false },
      { type: "CNAME" as const, name: "links.mail", host: "links.mail.example.com", value: "t.bird.com", purpose: "tracking" as const, optional: true },
      { type: "TXT" as const, name: "_dmarc.mail", host: "_dmarc.mail.example.com", value: "v=DMARC1; p=none", purpose: "dmarc" as const, optional: false },
      { type: "MX" as const, name: "mail", host: "mail.example.com", value: "10 inbound.us1.bird.com", purpose: "inbound_mx" as const, optional: true },
    ],
  };

  test("sending records, DMARC when needed, the MX when receiving, never tracking", () => {
    const records = birdDomainRecords(domain, { receiving: true, needsDmarc: true });
    expect(records.map((record) => [record.type, record.name, record.value, record.priority])).toEqual([
      ["TXT", "bird1._domainkey.mail.example.com", "v=DKIM1; p=MIG", undefined],
      ["CNAME", "send.mail.example.com", "rp.bird.com", undefined],
      ["TXT", "_dmarc.mail.example.com", "v=DMARC1; p=none", undefined],
      ["MX", "mail.example.com", "inbound.us1.bird.com", 10],
    ]);
    expect(birdDomainRecords(domain, { receiving: false, needsDmarc: false })).toHaveLength(2);
  });

  test("ready to send once Bird says so, receiving from its switch", async () => {
    const fake = fakeFetch({
      "GET /v1/email/domains": () =>
        Response.json({
          data: [{ ...domain, status: "verified", capabilities: { sending: { status: "verified" } }, receiving: { state: "enabled" } }],
          next_cursor: null,
        }),
    });
    expect(await new BirdProvider(target, fake.fetcher).listDomains()).toEqual([
      { id: "dom_1", name: "mail.example.com", status: "verified", sending: true, receiving: true },
    ]);
  });

  test("receiving is a PATCH on the domain", async () => {
    const fake = fakeFetch({ "GET /v1/email/domains": () => Response.json({ data: [domain], next_cursor: null }) });
    await new BirdProvider(target, fake.fetcher).setReceiving("mail.example.com", true);
    expect(fake.calls.at(-1)).toMatchObject({ method: "PATCH", body: { inbound: { enabled: true } } });
  });
});

describe("events", () => {
  test("only a hard bounce marks the address", () => {
    expect(birdDeliveryType({ type: "email.delivered" })).toBe("email.delivered");
    expect(birdDeliveryType({ type: "email.bounced", data: { bounce_type: "hard" } })).toBe("email.bounced");
    expect(birdDeliveryType({ type: "email.bounced", data: { bounce_type: "block" } })).toBe("email.failed");
    expect(birdDeliveryType({ type: "email.deferred" })).toBe("email.delivery_delayed");
    expect(birdDeliveryType({ type: "email.complained" })).toBe("email.complained");
    expect(birdDeliveryType({ type: "email.opened" })).toBeNull();
  });

  test("received mail gives its recipients and checks", () => {
    expect(birdInboundHint({ type: "email.received", data: { to: ["Support <Support@acme.com>", { email: "team@acme.com" }], spf_pass: true, dkim_pass: null } })).toEqual({
      recipients: ["support@acme.com", "team@acme.com"],
      authentication: { spf: "pass" },
    });
  });

  test("checks Standard Webhooks signatures", () => {
    const secret = `whsec_${Buffer.from("key-bytes").toString("base64")}`;
    const body = new TextEncoder().encode('{"type":"email.delivered"}');
    const timestamp = "1800000000";
    const sig = createHmac("sha256", Buffer.from("key-bytes")).update(`msg_1.${timestamp}.`).update(body).digest("base64");
    const input = { id: "msg_1", timestamp, signature: `v1,old v1,${sig}`, body };
    expect(verifyBirdSignature(secret, input, 1_800_000_000_000)).toBe(true);
    expect(verifyBirdSignature(secret, { ...input, id: "msg_2" }, 1_800_000_000_000)).toBe(false);
    expect(verifyBirdSignature(secret, input, 1_800_000_000_000 + 600_000)).toBe(false);
  });
});
