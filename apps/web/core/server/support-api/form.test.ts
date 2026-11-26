import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { messages, supportConversations, supportInboxes, threads, uploads } from "@hellobox/db";
import { getExtensions, resetExtensions } from "@hellobox/extensions";
import { and, eq } from "drizzle-orm";
import { hasServices, memoryStorage, recordedAfter, storedFiles, testDb, testSupportInbox, testWorkspace } from "../../../../../packages/mail/src/testing";

Object.assign(process.env, {
  S3_ENDPOINT: "http://localhost:9", S3_REGION: "auto", S3_BUCKET: "test", S3_ACCESS_KEY_ID: "x", S3_SECRET_ACCESS_KEY: "x",
  APP_URL: "https://hellobox.test",
});
memoryStorage();
void mock.module("server-only", () => ({}));
void mock.module("@/core/extensions", () => ({ getExtensions }));
const { generateFormKey, postSupportMessage, setSupportWebhookEnqueue } = await import("@hellobox/mail");
const { FORM_LIMITS, formDetails, formPreflight, postForm, SPAM } = await import("./form");
const { policy } = await import("./page");
const { GET: formPage } = await import("../../../app/support/f/[key]/route");

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 5, 0, 0, 0, 5, 8, 6, 0, 0, 0]);

test("the form page lets Turnstile in only when it's on", () => {
  expect(policy([])).not.toContain("challenges.cloudflare.com");
  expect(policy([], true)).toContain("script-src 'self' https://challenges.cloudflare.com");
  expect(policy([], true)).toContain("frame-src https://challenges.cloudflare.com");
  expect(policy([], true)).toContain("connect-src 'self'");
});

describe.skipIf(!hasServices)("the public form", () => {
  const db = testDb();
  const after = recordedAfter();
  let w: Awaited<ReturnType<typeof testWorkspace>>;
  let inbox: Awaited<ReturnType<typeof testSupportInbox>>;
  let key: string;
  let counter = 0;
  let verdict: boolean | null = true;
  const ip = () => `test-${crypto.randomUUID()}`;

  beforeAll(async () => {
    setSupportWebhookEnqueue(async () => undefined as never);
    w = await testWorkspace();
    inbox = await testSupportInbox(w);
    key = generateFormKey();
    await db.update(supportInboxes).set({ formKey: key, allowedOrigins: ["https://acme.test"] }).where(eq(supportInboxes.id, inbox.id));
  });
  afterAll(() => {
    delete process.env.TURNSTILE_SECRET_KEY;
    storedFiles.clear();
    resetExtensions();
  });

  const fields = (change: object = {}) => ({ email: `c${++counter}@customer.test`, name: "Ada", text: "Hello", idempotencyKey: `f${counter}`, ...change });
  type Body = { received?: boolean; conversationId?: string; error?: { code: string; message: string } };
  async function send(body: BodyInit, headers: Record<string, string> = {}, formKey = key) {
    const response = await postForm(
      new Request("http://x/", {
        method: "POST", body, duplex: "half",
        headers: { ...(body instanceof FormData ? {} : { "content-type": "application/json" }), "x-real-ip": headers["x-real-ip"] ?? ip(), ...headers },
      } as RequestInit),
      formKey,
      (row, message, source, _after, upload, suspected) => postSupportMessage(row, message, source, after, upload, suspected),
      async () => verdict,
    );
    return { status: response.status, headers: response.headers, body: (await response.json()) as Body };
  }
  const json = (change: object = {}, headers: Record<string, string> = {}) => send(JSON.stringify(fields(change)), headers);
  const stored = async (text: string) => {
    const [row] = await db
      .select({ folder: threads.folder, spamReasons: messages.spamReasons, conversation: supportConversations })
      .from(messages)
      .innerJoin(threads, eq(threads.id, messages.threadId))
      .innerJoin(supportConversations, eq(supportConversations.threadId, threads.id))
      .where(and(eq(messages.workspaceId, w.workspace.id), eq(messages.textBody, text)));
    return row;
  };

  test("a message starts a new, unverified conversation and reveals nothing", async () => {
    // A verified customer with the same address already has a conversation.
    const own = await postSupportMessage(await inbox.row(), { user: { id: "u1", email: "ada@customer.test" }, text: "Mine", idempotencyKey: "own" }, "api", after);
    expect(own.status).toBe("stored");
    const result = await json({ text: "From the form", subject: "Mine", email: "ada@customer.test" });
    expect(result).toMatchObject({ status: 201, body: { received: true } });
    expect(result.body.conversationId).toBeUndefined();
    const row = await stored("From the form");
    expect(row).toMatchObject({ folder: "inbox", conversation: { verified: false, externalUserId: null, email: "ada@customer.test" } });
    expect(row!.conversation.id).not.toBe(own.status === "stored" ? own.conversationId : "");
  });

  test("it can't continue a conversation or send metadata", async () => {
    const result = await json({ text: "Sneaky", conversationId: "anything", metadata: { plan: "pro" }, user: { id: "u1" } });
    expect(result.status).toBe(201);
    const row = await stored("Sneaky");
    expect(row!.conversation).toMatchObject({ verified: false, externalUserId: null, metadata: {} });
  });

  test("the same message sent again is stored once", async () => {
    const body = fields({ text: "Twice" });
    expect((await send(JSON.stringify(body))).status).toBe(201);
    expect((await send(JSON.stringify(body))).status).toBe(201);
    const rows = await db.select().from(messages).where(and(eq(messages.workspaceId, w.workspace.id), eq(messages.textBody, "Twice")));
    expect(rows).toHaveLength(1);
  });

  test("a filled hidden field goes to Spam with the reason, never dropped", async () => {
    expect((await json({ text: "Buy now", website: "http://spam.test" })).status).toBe(201);
    expect(await stored("Buy now")).toMatchObject({ folder: "spam", spamReasons: [SPAM.trap] });
  });

  test("with Turnstile on, a failed or missing check goes to Spam; an outage lets it in", async () => {
    process.env.TURNSTILE_SECRET_KEY = "secret";
    try {
      verdict = false;
      await json({ text: "Failed check", turnstileToken: "t" });
      await json({ text: "No check" });
      verdict = null;
      await json({ text: "Outage", turnstileToken: "t" });
      verdict = true;
      await json({ text: "Passed", turnstileToken: "t" });
    } finally {
      delete process.env.TURNSTILE_SECRET_KEY;
    }
    expect(await stored("Failed check")).toMatchObject({ folder: "spam", spamReasons: [SPAM.bot] });
    expect(await stored("No check")).toMatchObject({ folder: "spam", spamReasons: [SPAM.bot] });
    expect((await stored("Outage"))!.folder).toBe("inbox");
    expect((await stored("Passed"))!.folder).toBe("inbox");
  });

  test("other sites' pages are refused; allowed ones and this site get CORS", async () => {
    const refused = await json({ text: "Elsewhere" }, { origin: "https://evil.test" });
    expect(refused).toMatchObject({ status: 403, body: { error: { code: "forbidden_origin" } } });
    expect(refused.headers.get("access-control-allow-origin")).toBeNull();
    expect(await stored("Elsewhere")).toBeUndefined();
    const allowed = await json({ text: "From Acme" }, { origin: "https://acme.test" });
    expect(allowed.status).toBe(201);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://acme.test");
    expect((await json({ text: "From us" }, { origin: "https://hellobox.test" })).status).toBe(201);
    const preflight = (origin: string) => formPreflight(new Request("http://x/", { method: "OPTIONS", headers: { origin } }), key);
    expect((await preflight("https://acme.test")).status).toBe(204);
    expect((await preflight("https://evil.test")).status).toBe(403);
  });

  test("an unknown or turned-off form is a 404", async () => {
    expect((await send(JSON.stringify(fields()), {}, generateFormKey())).status).toBe(404);
    expect((await send(JSON.stringify(fields()), {}, inbox.key)).status).toBe(404);
    expect((await formDetails(new Request("http://x/"), key)).status).toBe(200);
    expect((await formPage(new Request("http://x/"), { params: Promise.resolve({ key: "hbf_nope" }) })).status).toBe(404);
    const shown = await formPage(new Request("http://x/"), { params: Promise.resolve({ key }) });
    expect(shown.status).toBe(200);
    expect(shown.headers.get("content-security-policy")).toContain("frame-ancestors https://acme.test");
  });

  test("one address can send only a few a minute", async () => {
    const address = ip();
    for (let i = 0; i < FORM_LIMITS.ip; i++) expect((await json({}, { "x-real-ip": address })).status).toBe(201);
    const limited = await json({}, { "x-real-ip": address });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
  });

  test("only images are taken, and a refused one leaves nothing behind", async () => {
    const before = storedFiles.size;
    const data = (name: string, body: BlobPart, type: string, text: string) => {
      const form = new FormData();
      form.append("message", JSON.stringify(fields({ text })));
      form.append("files", new File([body], name, { type }));
      return form;
    };
    // Named and labeled as an image, but it isn't one.
    const refused = await send(data("cat.png", "<html>hi</html>", "image/png", "Fake image"));
    expect(refused).toMatchObject({ status: 422, body: { error: { code: "unsafe_file" } } });
    expect(storedFiles.size).toBe(before);
    expect(await db.select().from(uploads).where(eq(uploads.workspaceId, w.workspace.id))).toHaveLength(0);
    expect(await stored("Fake image")).toBeUndefined();
    const taken = await send(data("cat.png", PNG, "image/png", "Real image"));
    expect(taken.status).toBe(201);
    expect(storedFiles.size).toBe(before + 1);
  });
});
