import { describe, expect, test } from "bun:test";
import { type MultipartLimits, readMultipart } from "./multipart";

const limits: MultipartLimits = { totalBytes: 10_000, fileBytes: 1000, files: 2, fields: 1, fieldBytes: 100, timeoutMs: 2000, idleMs: 1000 };
const type = "multipart/form-data; boundary=b";
const field = (name: string, value: string) => `--b\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
const file = (name: string, body: string) => `--b\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\n${body}\r\n`;
const stream = (...chunks: string[]) => new ReadableStream<Uint8Array>({
  start(c) { for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk)); c.close(); },
});

async function read(body: ReadableStream<Uint8Array>, options: { type?: string; limits?: Partial<MultipartLimits> } = {}) {
  const parts: string[] = [];
  for await (const part of readMultipart(body, options.type ?? type, { ...limits, ...options.limits })) {
    if (part.kind === "field") { parts.push(`${part.name}=${part.value}`); continue; }
    let size = 0;
    for await (const chunk of part.body) size += (chunk as Buffer).length;
    parts.push(`${part.filename}:${size}`);
  }
  return parts;
}
const refused = (kind: string, body: ReadableStream<Uint8Array>, options?: Parameters<typeof read>[1]) =>
  expect(read(body, options)).rejects.toMatchObject({ kind });

describe("multipart", () => {
  test("gives the parts in order, however they're cut up", async () => {
    const whole = field("message", "hé") + file("a.txt", "x".repeat(1000)) + file("naïve.txt", "") + "--b--\r\n";
    const expected = ["message=hé", "a.txt:1000", "naïve.txt:0"];
    expect(await read(stream(whole))).toEqual(expected);
    const bytes = new TextEncoder().encode(whole);
    const trickle = new ReadableStream<Uint8Array>({
      start(c) { for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7)); c.close(); },
    });
    expect(await read(trickle)).toEqual(expected);
  });
  test("has limits", async () => {
    await refused("too-large", stream(file("a", "x".repeat(1001)), "--b--\r\n"));
    await refused("too-large", stream(field("message", "x".repeat(101)), "--b--\r\n"));
    await refused("too-many", stream(file("a", "1") + file("b", "2") + file("c", "3") + "--b--\r\n"));
    await refused("too-many", stream(field("a", "1") + field("b", "2") + "--b--\r\n"));
    await refused("too-large", stream(file("a", "x"), "y".repeat(20_000)), { limits: { fileBytes: 1e9 } });
  });
  test("refuses what's broken or cut off", async () => {
    await refused("malformed", stream(field("message", "x")));
    await refused("malformed", stream(file("a", "half").slice(0, -4)));
    await refused("malformed", stream("nothing like it"));
    await refused("malformed", stream(""), { type: "multipart/form-data" });
    const broken = new ReadableStream<Uint8Array>({
      pull(c) { c.error(new Error("connection reset")); },
    });
    await refused("malformed", broken);
  });
  test("gives up on a body that stops", async () => {
    let cancelled = false;
    const stuck = () => new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode(file("a", "half").slice(0, -2))); },
      cancel() { cancelled = true; },
    });
    await refused("timeout", stuck(), { limits: { idleMs: 30 } });
    await refused("timeout", stuck(), { limits: { timeoutMs: 30 } });
    expect(cancelled).toBe(true);
  });
  test("reads an endless body no further than its limit", async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({ pull(c) { pulled += 1024; c.enqueue(new TextEncoder().encode(pulled === 1024 ? file("a", "") : "x".repeat(1024))); } });
    await refused("too-large", endless, { limits: { fileBytes: 1e9 } });
    expect(pulled).toBeLessThan(400_000);
  });
  test("stops reading when nobody wants the rest", async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({ pull(c) { pulled += 1024; c.enqueue(new TextEncoder().encode(pulled === 1024 ? field("message", "x") + file("a", "").slice(0, -2) : "x".repeat(1024))); } });
    for await (const part of readMultipart(endless, type, { ...limits, totalBytes: 1e9, fileBytes: 1e9 })) {
      expect(part.kind).toBe("field");
      break;
    }
    const then = pulled;
    await Bun.sleep(20);
    expect(pulled).toBeLessThan(then + 200_000);
  });
});
