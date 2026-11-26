import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { attachments, messages, supportMessages, threads, uploads, workspaces } from "@hellobox/db";
import { UNLIMITED } from "@hellobox/extensions";
import { eq } from "drizzle-orm";
import { hasServices, memoryStorage, recordedAfter, storedFiles, testDb, testSupportInbox, testWorkspace } from "../../../../../packages/mail/src/testing";

Object.assign(process.env, {
  S3_ENDPOINT: "http://localhost:9", S3_REGION: "auto", S3_BUCKET: "test", S3_ACCESS_KEY_ID: "x", S3_SECRET_ACCESS_KEY: "x",
});
memoryStorage();
const { cleanFilename, discardFiles, postSupportMessage, previewType, storeSupportFile } = await import("@hellobox/mail");
const { postMessage } = await import("./messages");
const { withUploadSlot } = await import("./slots");

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 5, 0, 0, 0, 5, 8, 6, 0, 0, 0]);
const after = recordedAfter();

test("names are only shown: no paths, control characters or hidden endings", () => {
  expect(cleanFilename("../../etc/passwd")).toBe("passwd");
  expect(cleanFilename("C:\\x\\run.exe. .")).toBe("run.exe");
  expect(cleanFilename("a\r\nb\u0000.txt")).toBe("a b.txt");
  expect(cleanFilename("fo\u202egpj.exe")).toBe("fogpj.exe");
  expect(cleanFilename("..")).toBe("file");
  expect(cleanFilename(`${"x".repeat(300)}.png`)).toHaveLength(200);
  expect(cleanFilename(`${"x".repeat(300)}.png`)).toEndWith(".png");
});

describe.skipIf(!hasServices)("a message with files", () => {
  const db = testDb();
  let w: Awaited<ReturnType<typeof testWorkspace>>;
  let inbox: Awaited<ReturnType<typeof testSupportInbox>>;
  let keyId: string;
  let counter = 0;
  beforeAll(async () => {
    w = await testWorkspace();
    inbox = await testSupportInbox(w);
    keyId = inbox.id;
  });
  afterAll(() => storedFiles.clear());

  const message = (change: object = {}) => ({ user: { id: `u${++counter}`, email: "ada@customer.test" }, text: "Help", idempotencyKey: `k${counter}`, ...change });
  const form = (json: unknown, files: [string, BlobPart, string?][] = []) => {
    const data = new FormData();
    data.append("message", typeof json === "string" ? json : JSON.stringify(json));
    for (const [name, body, type] of files) data.append("files", new File([body], name, { type: type ?? "text/plain" }));
    return data;
  };
  type Body = { conversationId?: string; messageId?: string; error?: { code: string; message: string } };
  async function send(body: BodyInit, headers: Record<string, string> = {}, post: typeof postSupportMessage = postSupportMessage) {
    const response = await postMessage(
      new Request("http://x/", { method: "POST", body, headers: { authorization: `Bearer ${inbox.key}`, ...headers }, duplex: "half" } as RequestInit),
      (row, m, source, _after, upload) => post(row, m, source, after, upload),
    );
    return { status: response.status, body: (await response.json()) as Body };
  }
  const used = async () => (await db.select({ n: workspaces.storageBytesUsed }).from(workspaces).where(eq(workspaces.id, w.workspace.id)))[0]!.n;
  const left = async () => ({
    files: storedFiles.size,
    uploads: (await db.select().from(uploads).where(eq(uploads.workspaceId, w.workspace.id))).length,
    messages: (await db.select().from(messages).where(eq(messages.workspaceId, w.workspace.id))).length,
    threads: (await db.select().from(threads).where(eq(threads.workspaceId, w.workspace.id))).length,
    used: await used(),
  });
  // Runs something that must fail, and checks that nothing at all is different.
  async function leavesNothing(run: () => Promise<{ status: number; body: Body }>) {
    const before = await left();
    const result = await run();
    expect(await left()).toEqual(before);
    return result;
  }

  test("is stored with them, once", async () => {
    const start = await used();
    const json = message();
    const files: [string, BlobPart, string][] = [["notes.txt", "hello", "text/plain"], ["shot.png", PNG, "image/png"], ["shot.png", "<script>", "image/png"], ["page.html", "<b>", "text/html"]];
    const first = await send(form(json, files));
    expect(first.status).toBe(201);
    const rows = await db.select().from(attachments).where(eq(attachments.messageId, first.body.messageId!));
    expect(rows.map((r) => [r.filename, r.contentType, r.size]).sort()).toEqual([
      ["notes.txt", "text/plain", 5], ["page.html", "text/html", 3],
      // HTML named .png isn't an image, so it downloads.
      ["shot.png", "application/octet-stream", 8], ["shot.png", "image/png", PNG.length],
    ].sort());
    for (const row of rows) {
      expect(row.storageKey).toStartWith(`workspaces/${w.workspace.id}/messages/${first.body.messageId}/`);
      expect(row.storageKey).not.toContain("shot");
      expect(previewType(storedFiles.get(row.storageKey)!)).toBe(row.contentType === "image/png" ? "image/png" : null);
    }
    expect(await used()).toBe(start + 5 + 3 + 8 + PNG.length);
    expect((await left()).uploads).toBe(0);
    const [thread] = await db.select().from(threads).innerJoin(messages, eq(messages.threadId, threads.id)).where(eq(messages.id, first.body.messageId!));
    expect(thread!.threads.hasAttachments).toBe(true);

    expect(await leavesNothing(() => send(form(json, files)))).toEqual(first);
    for (const other of [files.slice(1), [["notes.txt", "Hello", "text/plain"], ...files.slice(1)] as typeof files, []]) {
      expect(await leavesNothing(() => send(form(json, other)))).toMatchObject({ status: 409, body: { error: { code: "idempotency_key_reused" } } });
    }
    const asJson = await leavesNothing(() => send(JSON.stringify(json), { "content-type": "application/json" }));
    expect(asJson.status).toBe(409);
  });

  test("is stored once when it's sent twice at the same time", async () => {
    const json = message();
    const before = await left();
    const both = await Promise.all([1, 2].map(() => send(form(json, [["a.txt", "same"]]))));
    expect(both.map((r) => r.status)).toEqual([201, 201]);
    expect(both[0]!.body).toEqual(both[1]!.body);
    expect(await left()).toEqual({ files: before.files + 1, uploads: 0, messages: before.messages + 1, threads: before.threads + 1, used: before.used + 4 });
  });

  test("with no files is the same as JSON", async () => {
    const json = message();
    const first = await send(form(json));
    expect(first.status).toBe(201);
    expect(await send(JSON.stringify(json), { "content-type": "application/json" })).toEqual(first);
  });

  const boundary = "b0undary";
  const head = (json: unknown) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="message"\r\n\r\n${JSON.stringify(json)}\r\n--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="a.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const multipart = { "content-type": `multipart/form-data; boundary=${boundary}` };

  test("that's cut off leaves nothing behind", async () => {
    const closed = () => new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode(head(message()))); c.enqueue(new Uint8Array(200_000)); c.close(); },
    });
    const reset = () => {
      let sent = 0;
      return new ReadableStream<Uint8Array>({
        pull(c) {
          if (sent++ === 0) c.enqueue(new TextEncoder().encode(head(message())));
          else if (sent < 20) c.enqueue(new Uint8Array(50_000));
          else c.error(new Error("reset"));
        },
      });
    };
    for (const body of [closed, reset]) {
      const result = await leavesNothing(() => send(body(), multipart));
      expect(result).toMatchObject({ status: 400, body: { error: { code: "invalid_request" } } });
    }
    // After a file that had already arrived whole.
    const whole = `${head(message())}done\r\n--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="b"\r\n\r\nhal`;
    expect((await leavesNothing(() => send(new Blob([whole]).stream(), multipart))).status).toBe(400);
  });

  test("that can't be stored leaves nothing behind", async () => {
    const failing = (async () => { throw new Error("database down"); }) as unknown as typeof postSupportMessage;
    expect((await leavesNothing(() => send(form(message(), [["a.txt", "x"]]), {}, failing))).status).toBe(500);
    const missing = message({ conversationId: crypto.randomUUID() });
    expect((await leavesNothing(() => send(form(missing, [["a.txt", "x"]])))).status).toBe(404);
  });

  test("keeps its files when it was stored and the answer was lost", async () => {
    const before = await left();
    const lost = (async (...args: Parameters<typeof postSupportMessage>) => {
      await postSupportMessage(...args);
      throw new Error("connection lost");
    }) as typeof postSupportMessage;
    const json = message();
    expect((await send(form(json, [["a.txt", "kept"]]), {}, lost)).status).toBe(500);
    expect(await left()).toMatchObject({ files: before.files + 1, messages: before.messages + 1, uploads: 0 });
    expect((await send(form(json, [["a.txt", "kept"]]))).status).toBe(201);
    expect((await left()).messages).toBe(before.messages + 1);
  });

  test("is refused over the limits, whatever Content-Length says", async () => {
    const big = (mb: number) => new Uint8Array(mb * 1024 * 1024);
    const tooLarge = { status: 413, body: { error: { code: "too_large" } } };
    expect(await leavesNothing(() => send(form(message(), [["a", big(10.1)]])))).toMatchObject(tooLarge);
    expect(await leavesNothing(() => send(form(message(), [["a", big(9)], ["b", big(9)], ["c", big(3)]])))).toMatchObject(tooLarge);
    expect(await leavesNothing(() => send(form(message(), Array.from({ length: 6 }, (_, i) => [`f${i}`, "x"] as [string, string]))))).toMatchObject(tooLarge);
    expect(await leavesNothing(() => send(new ReadableStream({}), { ...multipart, "content-length": String(50 * 1024 * 1024) }))).toMatchObject(tooLarge);
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(c) { pulled += 1; c.enqueue(pulled === 1 ? new TextEncoder().encode(head(message())) : new Uint8Array(1024 * 1024)); },
    });
    expect(await leavesNothing(() => send(endless, { ...multipart, "content-length": "100" }))).toMatchObject(tooLarge);
    expect(pulled).toBeLessThan(40);
    expect((await send(form(message(), [["a", big(10)], ["b", big(10)]]))).status).toBe(201);
  }, 60_000);

  test("refuses files that run, and parts in the wrong place", async () => {
    const risky = await leavesNothing(() => send(form(message(), [["ok.txt", "x"], ["setup.exe. ", "x"]])));
    expect(risky).toMatchObject({ status: 422, body: { error: { code: "unsafe_file" } } });
    expect(risky.body.error!.message).toContain("setup.exe");
    const backwards = new FormData();
    backwards.append("files", new File(["x"], "a.txt"));
    backwards.append("message", JSON.stringify(message()));
    expect((await leavesNothing(() => send(backwards))).status).toBe(400);
    expect((await leavesNothing(() => send(form("{")))).status).toBe(400);
    const wrong = new FormData();
    wrong.append("text", "x");
    expect((await leavesNothing(() => send(wrong))).status).toBe(400);
  });

  test("is refused when storage is full, and fine without files", async () => {
    const limits = { ...UNLIMITED.limits, storageBytes: (await used()) + 3 };
    w.installAll({ billing: { entitlements: async () => ({ ...UNLIMITED, limits }), denied: () => new Error("denied") } });
    const json = message();
    expect(await leavesNothing(() => send(form(json, [["a.txt", "four"]])))).toMatchObject({ status: 409, body: { error: { code: "storage_full" } } });
    expect((await send(form(json))).status).toBe(201);
    w.installAll();
  });

  test("two uploads at once per key, ten in all", async () => {
    const scope = `test-${crypto.randomUUID()}`;
    const open: (() => void)[] = [];
    const hold = (key: string) => new Promise<void>((started, rejected) => {
      withUploadSlot(key, () => { started(); return new Promise<void>((done) => open.push(done)); }, scope).catch(rejected);
    });
    for (const key of ["a", "b", "c", "d", "e"]) { await hold(key); if (key !== "a") await hold(key); }
    await hold("a");
    await expect(hold("a")).rejects.toMatchObject({ status: 429 });
    await expect(hold("f")).rejects.toMatchObject({ status: 429 });
    open.pop()!();
    await Bun.sleep(50);
    await hold("f");
    await expect(withUploadSlot("g", async () => { throw new Error("x"); }, `${scope}2`)).rejects.toThrow("x");
    for (const done of open) done();
    expect(keyId).toBeTruthy();
  });

  test("a file maintenance already deleted can't be kept", async () => {
    const { Readable } = await import("node:stream");
    const file = await storeSupportFile(w.workspace.id, crypto.randomUUID(), { filename: "a", contentType: "", body: Readable.from([Buffer.from("x")]) });
    await discardFiles([file.uploadId]);
    const before = await left();
    const row = await inbox.row();
    await expect(postSupportMessage(row, message(), "api", after, { messageId: crypto.randomUUID(), files: [file] })).rejects.toThrow("cleaned up");
    expect(await left()).toEqual(before);
    expect((await db.select().from(supportMessages).where(eq(supportMessages.inboxId, inbox.id))).length).toBeGreaterThan(0);
  });
});
