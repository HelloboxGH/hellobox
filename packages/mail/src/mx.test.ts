import { describe, expect, it } from "bun:test";
import {
  checkMxSignature,
  helloboxEmailId,
  helloboxMxHost,
  helloboxMxRecord,
  isHelloboxReceived,
  mxPointsHere,
  mxRecipientDecision,
  type MxDeps,
  mxSignature,
  parseMxEnvelope,
  receiveFromMx,
} from "./mx";

const body = new TextEncoder().encode("Subject: hi\r\n\r\nhello\r\n");
const now = 1_800_000_000_000;
const timestamp = String(now / 1000);
const path = "/api/mx/v1/messages";

const envelopeOf = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

describe("checkMxSignature", () => {
  const signed = (key = "k") => ({ timestamp, signature: mxSignature(key, timestamp, path, "env", body), path, envelope: "env", body });

  it("accepts what was signed with the key", () => {
    expect(checkMxSignature(signed(), "k", now)).toEqual({ ok: true });
  });

  it("refuses another key, another body, another envelope or another call", () => {
    expect(checkMxSignature(signed("other"), "k", now).ok).toBe(false);
    expect(checkMxSignature({ ...signed(), body: new Uint8Array([1]) }, "k", now).ok).toBe(false);
    expect(checkMxSignature({ ...signed(), envelope: "changed" }, "k", now).ok).toBe(false);
    expect(checkMxSignature({ ...signed(), path: "/api/mx/v1/recipients" }, "k", now).ok).toBe(false);
  });

  it("refuses old or missing timestamps", () => {
    expect(checkMxSignature(signed(), "k", now + 301_000)).toEqual({ ok: false, status: 401 });
    expect(checkMxSignature({ ...signed(), timestamp: null }, "k", now)).toEqual({ ok: false, status: 401 });
  });

  it("asks the mail server to retry when receiving isn't set up", () => {
    expect(checkMxSignature(signed(), undefined, now)).toEqual({ ok: false, status: 503 });
  });
});

describe("parseMxEnvelope", () => {
  it("lowercases and dedupes recipients", () => {
    const parsed = parseMxEnvelope(envelopeOf({ recipients: ["Team@Acme.example", "team@acme.example"], mailFrom: "a@b.example", ip: "203.0.113.9", helo: "h" }));
    expect(parsed).toEqual({ recipients: ["team@acme.example"], mailFrom: "a@b.example", ip: "203.0.113.9", helo: "h" });
  });

  it("refuses an envelope without recipients or an IP", () => {
    expect(parseMxEnvelope(envelopeOf({ recipients: [], ip: "1.2.3.4" }))).toBeNull();
    expect(parseMxEnvelope(envelopeOf({ recipients: ["a@b.example"] }))).toBeNull();
    expect(parseMxEnvelope("not base64 json")).toBeNull();
  });
});

type Copy = Awaited<ReturnType<MxDeps["receivingCopies"]>>[number];
const copy = (connectionId: string, workspaceId: string, name: string, bouncesEnabled = false): Copy => ({
  id: `d-${connectionId}-${name}`,
  workspaceId,
  connectionId,
  name,
  removedAt: null,
  bouncesEnabled,
});

function deps(byDomain: Record<string, Copy[]>, fail = false, mailboxes: string[] = [], blocked: string[] = []) {
  const received: Parameters<MxDeps["receive"]>[0][] = [];
  const value: MxDeps = {
    senderBlocked: async (workspaceId) => blocked.includes(workspaceId),
    receivingCopies: async (name) => byDomain[name] ?? [],
    hasMailbox: async (_workspaceId, address) => mailboxes.includes(address),
    receive: async (email) => {
      if (fail) throw new Error("storage down");
      received.push(email);
      return { emailId: email.emailId };
    },
    authenticate: async () => ({ spf: "pass", dkim: "pass", dmarc: "pass" }),
  };
  return { value, received };
}

const envelope = (recipients: string[]) => ({ recipients, mailFrom: "ada@sender.example", ip: "203.0.113.9", helo: "mail.sender.example" });

describe("receiveFromMx", () => {
  it("stores once per connection, with only that connection's recipients", async () => {
    const { value, received } = deps({
      "acme.example": [copy("c1", "w1", "acme.example")],
      "help.acme.example": [copy("c2", "w1", "help.acme.example")],
    });
    const result = await receiveFromMx(body, envelope(["team@acme.example", "sales@acme.example", "x@help.acme.example", "y@elsewhere.example"]), value);
    expect(result.status).toBe("stored");
    expect(received.map((email) => [email.connectionId, email.hint?.recipients])).toEqual([
      ["c1", ["team@acme.example", "sales@acme.example"]],
      ["c2", ["x@help.acme.example"]],
    ]);
    expect(received.every((email) => isHelloboxReceived(email.emailId))).toBe(true);
    expect(received[0]?.hint?.authentication).toEqual({ spf: "pass", dkim: "pass", dmarc: "pass" });
  });

  it("gives a retry the same id, so it isn't stored twice", async () => {
    const first = deps({ "acme.example": [copy("c1", "w1", "acme.example")] });
    const second = deps({ "acme.example": [copy("c1", "w1", "acme.example")] });
    await receiveFromMx(body, envelope(["team@acme.example"]), first.value);
    await receiveFromMx(body, envelope(["team@acme.example"]), second.value);
    expect(first.received[0]?.emailId).toBe(second.received[0]?.emailId as string);
    expect(helloboxEmailId(body, ["b@x.example", "a@x.example"])).toBe(helloboxEmailId(body, ["a@x.example", "b@x.example"]));
    expect(helloboxEmailId(body, ["a@x.example"])).not.toBe(helloboxEmailId(body, ["b@x.example"]));
  });

  it("says so when no recipient receives here", async () => {
    const { value, received } = deps({});
    expect(await receiveFromMx(body, envelope(["team@acme.example"]), value)).toEqual({ status: "no-recipients" });
    expect(received).toHaveLength(0);
  });

  it("refuses a blocked sender without storing anything", async () => {
    const { value, received } = deps({ "acme.example": [copy("c1", "w1", "acme.example")] }, false, [], ["w1"]);
    expect(await receiveFromMx(body, envelope(["team@acme.example"]), value)).toEqual({ status: "blocked" });
    expect(received).toHaveLength(0);
  });

  it("still delivers to workspaces that didn't block the sender", async () => {
    const { value, received } = deps(
      { "acme.example": [copy("c1", "w1", "acme.example")], "other.example": [copy("c2", "w2", "other.example")] },
      false,
      [],
      ["w1"],
    );
    const result = await receiveFromMx(body, envelope(["team@acme.example", "x@other.example"]), value);
    expect(result.status).toBe("stored");
    expect(received.map((email) => email.connectionId)).toEqual(["c2"]);
  });

  it("throws when storing fails, so the sender retries", async () => {
    const { value } = deps({ "acme.example": [copy("c1", "w1", "acme.example")] }, true);
    await expect(receiveFromMx(body, envelope(["team@acme.example"]), value)).rejects.toThrow("storage down");
  });
});

describe("mxRecipientDecision", () => {
  const open = deps({ "acme.example": [copy("c1", "w1", "acme.example")] }).value;
  const strict = deps({ "acme.example": [copy("c1", "w1", "acme.example", true)] }, false, ["team@acme.example"]).value;

  it("takes any address at a receiving domain while bounces are off", async () => {
    expect(await mxRecipientDecision("anyone@acme.example", open)).toEqual({ accept: true, scope: "domain" });
    expect(await mxRecipientDecision(" Team@ACME.example ", open)).toEqual({ accept: true, scope: "domain" });
  });

  it("refuses unknown addresses when bounces are on, and says the answer is per address", async () => {
    expect(await mxRecipientDecision("Team@acme.example", strict)).toEqual({ accept: true, scope: "address" });
    expect(await mxRecipientDecision("nobody@acme.example", strict)).toEqual({ accept: false, scope: "address" });
  });

  it("refuses other domains for the whole domain, and things that aren't addresses", async () => {
    expect(await mxRecipientDecision("team@elsewhere.example", open)).toEqual({ accept: false, scope: "domain" });
    expect((await mxRecipientDecision("not-an-address", open)).accept).toBe(false);
    expect((await mxRecipientDecision("a@acme.example@evil.example", open)).accept).toBe(false);
  });
});

describe("helloboxMxHost", () => {
  const saved = { key: process.env.MX_SIGNING_KEY, host: process.env.MX_HOSTNAME };
  const restore = () => {
    for (const [name, value] of [["MX_SIGNING_KEY", saved.key], ["MX_HOSTNAME", saved.host]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };

  it("is the mail server's name only when both settings are there", () => {
    try {
      process.env.MX_SIGNING_KEY = "k";
      process.env.MX_HOSTNAME = " MX1.Example.com. ";
      expect(helloboxMxHost()).toBe("mx1.example.com");
      delete process.env.MX_SIGNING_KEY;
      expect(helloboxMxHost()).toBeNull();
      process.env.MX_SIGNING_KEY = "k";
      delete process.env.MX_HOSTNAME;
      expect(helloboxMxHost()).toBeNull();
    } finally {
      restore();
    }
  });

  it("gives a domain one MX record pointing at it", () => {
    expect(helloboxMxRecord("acme.example", "mx1.example.com")).toEqual({
      type: "MX",
      name: "acme.example",
      value: "mx1.example.com",
      priority: 10,
    });
  });
});

describe("mxPointsHere", () => {
  it("needs the mail server's record and nothing else", () => {
    expect(mxPointsHere([{ value: "mx1.hellobox.app" }], "mx1.hellobox.app")).toBe(true);
    expect(mxPointsHere([], "mx1.hellobox.app")).toBe(false);
    expect(mxPointsHere([{ value: "mx1.hellobox.app" }, { value: "aspmx.l.google.com" }], "mx1.hellobox.app")).toBe(false);
    expect(mxPointsHere([{ value: "receive-euw1.forge.rmta.net" }], "mx1.hellobox.app")).toBe(false);
  });
});
