import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import vm from "node:vm";
import { mxSignature } from "../../../packages/mail/src/mx";

// Loaded the way Haraka loads it (plugins.js _compile): the same sandbox globals, so using
// one Haraka doesn't give (like AbortSignal) fails here too.
const CODES = { OK: 906, DENY: 902, DENYSOFT: 903, DENYSOFTDISCONNECT: 904 };

function load(fetch) {
  const plugin = {};
  const sandbox = {
    require: createRequire(import.meta.url),
    __filename: "hellobox.js",
    __dirname: ".",
    exports: plugin,
    fetch,
    clearTimeout,
    clearInterval,
    process,
    setInterval,
    setTimeout,
    Buffer,
    Math,
    setImmediate,
    ...CODES,
  };
  vm.runInNewContext(`"use strict";${readFileSync(join(import.meta.dir, "hellobox.js"), "utf8")}`, sandbox);
  return plugin;
}

// Shaped like @haraka/email-address, which Haraka 3.4 uses.
const address = (value) => ({ user: value.split("@")[0], host: value.split("@")[1], address: value });

function connection(ip = "203.0.113.9") {
  return {
    remote: { ip },
    hello: { host: "mail.sender.example" },
    logerror() {},
    logwarn() {},
    transaction: {
      mail_from: address("ada@sender.example"),
      rcpt_to: [address("team@acme.example")],
      message_stream: { get_data: (cb) => cb(Buffer.from("Subject: hi\r\n\r\nhello\r\n")) },
    },
  };
}

// Calls a hook and resolves with what it answered.
const run = (hook, ...args) =>
  new Promise((resolve) => hook((code, message) => resolve({ code, message }), ...args));

const env = { HELLOBOX_URL: "https://hellobox.example/", MX_SIGNING_KEY: "test-key", MX_OPEN: "true" };
let saved;
beforeEach(() => {
  saved = { ...process.env };
  Object.assign(process.env, env);
});
afterEach(() => {
  process.env = saved;
});

describe("hellobox plugin", () => {
  it("answers 451 to every recipient until it's opened", async () => {
    process.env.MX_OPEN = "false";
    let calls = 0;
    const plugin = load(async () => {
      calls++;
      return Response.json({ accept: true });
    });
    const answer = await run(plugin.hook_rcpt.bind(plugin), connection(), [address("team@acme.example")]);
    expect(answer.code).toBe(CODES.DENYSOFT);
    expect(calls).toBe(0);
  });

  it("accepts a domain HelloBox takes, refuses one it doesn't, and caches the answer", async () => {
    const asked = [];
    const plugin = load(async (url, init) => {
      const { recipient } = JSON.parse(init.body.toString());
      asked.push(recipient);
      return Response.json({ accept: recipient.endsWith("@acme.example"), scope: "domain" });
    });
    const rcpt = (value) => run(plugin.hook_rcpt.bind(plugin), connection(), [address(value)]);
    expect((await rcpt("team@acme.example")).code).toBe(CODES.OK);
    expect((await rcpt("other@acme.example")).code).toBe(CODES.OK);
    expect((await rcpt("x@elsewhere.example")).code).toBe(CODES.DENY);
    expect(asked).toEqual(["team@acme.example", "x@elsewhere.example"]);
  });

  it("refuses an address with no mailbox when HelloBox says so, and asks about each address", async () => {
    const asked = [];
    const plugin = load(async (url, init) => {
      const { recipient } = JSON.parse(init.body.toString());
      asked.push(recipient);
      return Response.json({ accept: recipient === "team@acme.example", scope: "address" });
    });
    const rcpt = (value) => run(plugin.hook_rcpt.bind(plugin), connection(), [address(value)]);
    expect((await rcpt("team@acme.example")).code).toBe(CODES.OK);
    const refused = await rcpt("nobody@acme.example");
    expect(refused.code).toBe(CODES.DENY);
    expect(String(refused.message)).toContain("No such user");
    expect((await rcpt("team@acme.example")).code).toBe(CODES.OK);
    expect(asked).toEqual(["team@acme.example", "nobody@acme.example"]);
  });

  it("doesn't remember that an address had no mailbox, so a new mailbox receives at once", async () => {
    let exists = false;
    const plugin = load(async () => Response.json({ accept: exists, scope: "address" }));
    const rcpt = () => run(plugin.hook_rcpt.bind(plugin), connection(), [address("new@acme.example")]);
    expect((await rcpt()).code).toBe(CODES.DENY);
    exists = true;
    expect((await rcpt()).code).toBe(CODES.OK);
  });

  it("cuts off an IP that keeps naming unknown addresses", async () => {
    let calls = 0;
    const plugin = load(async () => {
      calls++;
      return Response.json({ accept: false, scope: "address" });
    });
    const rcpt = (value, ip = "192.0.2.7") => run(plugin.hook_rcpt.bind(plugin), connection(ip), [address(value)]);
    for (let i = 0; i < 10; i++) expect((await rcpt(`guess${i}@acme.example`)).code).toBe(CODES.DENY);
    expect((await rcpt("guess10@acme.example")).code).toBe(CODES.DENYSOFTDISCONNECT);
    expect(calls).toBe(10);
    // Another IP isn't affected, and refusals for a whole domain don't count as guesses.
    expect((await rcpt("guess11@acme.example", "192.0.2.8")).code).toBe(CODES.DENY);
  });

  it("answers 451 when HelloBox can't be reached", async () => {
    const plugin = load(async () => {
      throw new Error("down");
    });
    const answer = await run(plugin.hook_rcpt.bind(plugin), connection(), [address("team@acme.example")]);
    expect(answer.code).toBe(CODES.DENYSOFT);
  });

  it("signs the message the way HelloBox checks it", async () => {
    let request;
    const plugin = load(async (url, init) => {
      request = { url, init };
      return Response.json({ ids: ["hb_1"] });
    });
    const answer = await run(plugin.hook_queue.bind(plugin), connection());
    expect(answer.code).toBe(CODES.OK);
    expect(request.url).toBe("https://hellobox.example/api/mx/v1/messages");
    const headers = request.init.headers;
    const envelope = JSON.parse(Buffer.from(headers["x-hellobox-envelope"], "base64url").toString());
    expect(envelope).toEqual({
      recipients: ["team@acme.example"],
      mailFrom: "ada@sender.example",
      ip: "203.0.113.9",
      helo: "mail.sender.example",
    });
    const expected = mxSignature(
      "test-key",
      headers["x-hellobox-timestamp"],
      "/api/mx/v1/messages",
      headers["x-hellobox-envelope"],
      new Uint8Array(request.init.body),
    );
    expect(headers["x-hellobox-signature"]).toBe(expected);
    expect(request.init.redirect).toBe("error");
  });

  it("answers 550 when no recipient receives here any more, and 451 for anything else", async () => {
    for (const [status, code] of [
      [422, CODES.DENY],
      [503, CODES.DENYSOFT],
      [401, CODES.DENYSOFT],
      [500, CODES.DENYSOFT],
    ]) {
      const plugin = load(async () => new Response(null, { status }));
      expect((await run(plugin.hook_queue.bind(plugin), connection())).code).toBe(code);
    }
  });

  it("limits how many messages one IP starts in a minute", async () => {
    const plugin = load(async () => Response.json({}));
    const answers = [];
    for (let i = 0; i < 21; i++) answers.push((await run(plugin.hook_mail.bind(plugin), connection("198.51.100.4"))).code);
    expect(answers.slice(0, 20).every((code) => code === undefined)).toBe(true);
    expect(answers[20]).toBe(CODES.DENYSOFT);
    expect((await run(plugin.hook_mail.bind(plugin), connection("198.51.100.5"))).code).toBeUndefined();
  });
});
