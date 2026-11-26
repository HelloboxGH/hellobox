import { PassThrough, Readable, Transform } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { Busboy } from "@fastify/busboy";

// Reads a multipart body as it arrives, holding nothing but small fields in memory. It knows
// nothing about HelloBox, so it can move to a service of its own.

export interface MultipartLimits {
  totalBytes: number;
  fileBytes: number;
  files: number;
  fields: number;
  fieldBytes: number;
  // The whole body, and the longest silence.
  timeoutMs: number;
  idleMs: number;
}

export class MultipartError extends Error {
  constructor(
    readonly kind: "malformed" | "too-large" | "too-many" | "timeout",
    message: string,
  ) {
    super(message);
  }
}

export type MultipartPart =
  | { kind: "field"; name: string; value: string }
  // Read all of `body` before asking for the next part.
  | { kind: "file"; name: string; filename: string; contentType: string; body: Readable };

export async function* readMultipart(
  body: ReadableStream<Uint8Array>,
  contentType: string,
  limits: MultipartLimits,
): AsyncGenerator<MultipartPart> {
  const malformed = (message = "The body isn't valid multipart") => new MultipartError("malformed", message);
  const queue: MultipartPart[] = [];
  let finished = false;
  let failure: Error | undefined;
  let wake: () => void = () => undefined;
  const open = new Set<Readable>();

  let parser: InstanceType<typeof Busboy>;
  try {
    parser = new Busboy({
      headers: { "content-type": contentType },
      fileHwm: 64 * 1024,
      limits: {
        fieldNameSize: 100,
        fieldSize: limits.fieldBytes,
        fields: limits.fields,
        fileSize: limits.fileBytes,
        files: limits.files,
        parts: limits.files + limits.fields + 1,
        headerPairs: 20,
        headerSize: 4096,
      },
    });
  } catch {
    throw malformed();
  }

  const source = Readable.fromWeb(body as unknown as NodeReadableStream);
  let size = 0;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const tooSlow = () => fail(new MultipartError("timeout", "The request took too long to arrive"));
  const total = setTimeout(tooSlow, limits.timeoutMs);
  const listen = () => {
    clearTimeout(idle);
    idle = setTimeout(tooSlow, limits.idleMs);
  };
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      listen();
      size += chunk.length;
      if (size > limits.totalBytes) done(new MultipartError("too-large", "The request is too large"));
      else done(null, chunk);
    },
  });

  function fail(error: Error) {
    if (failure || finished) return;
    failure = error;
    clearTimeout(idle);
    clearTimeout(total);
    for (const file of open) file.destroy(error);
    source.unpipe(counter);
    counter.unpipe(parser);
    source.destroy();
    counter.destroy();
    wake();
  }

  source.on("error", () => fail(malformed("The request was cut off")));
  counter.on("error", (error) => fail(error instanceof MultipartError ? error : malformed()));
  parser.on("error", () => fail(malformed("The body isn't valid multipart, or it was cut off")));
  parser.on("partsLimit", () => fail(new MultipartError("too-many", "The request has too many parts")));
  parser.on("filesLimit", () => fail(new MultipartError("too-many", `The most is ${limits.files} files`)));
  parser.on("fieldsLimit", () => fail(new MultipartError("too-many", "The request has too many fields")));
  parser.on("field", (name, value, nameCut, valueCut) => {
    if (nameCut || valueCut) return fail(new MultipartError("too-large", "A field is too long"));
    queue.push({ kind: "field", name, value });
    wake();
  });
  parser.on("file", (name, file, filename, _encoding, type) => {
    // The parser's own stream fails with its own errors, so what's read is a copy of it.
    const out = new PassThrough();
    open.add(out);
    out.on("close", () => open.delete(out));
    // Without these, an error would take the process down.
    out.on("error", () => undefined);
    file.on("error", (error) => fail(error instanceof MultipartError ? error : malformed("The request was cut off")));
    file.on("limit", () => fail(new MultipartError("too-large", "A file is too large")));
    if (failure) return void out.destroy(failure);
    file.pipe(out);
    queue.push({ kind: "file", name, filename: filename ?? "", contentType: type, body: out });
    wake();
  });
  parser.on("finish", () => {
    finished = true;
    clearTimeout(idle);
    clearTimeout(total);
    wake();
  });

  listen();
  source.pipe(counter).pipe(parser);
  try {
    for (;;) {
      if (failure) throw failure;
      const part = queue.shift();
      if (part) {
        yield part;
        continue;
      }
      if (finished) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
        if (failure || finished || queue.length) resolve();
      });
    }
  } finally {
    // Whoever was reading stopped early.
    fail(malformed());
    clearTimeout(idle);
    clearTimeout(total);
  }
}
