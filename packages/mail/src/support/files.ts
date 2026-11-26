import { createHash } from "node:crypto";
import { type Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { getDb, uploads } from "@hellobox/db";
import { deleteObject, messageKey, streamToStorage } from "@hellobox/storage";
import { and, eq, inArray } from "drizzle-orm";
import { IMAGE_HEADER_BYTES, imageInfo } from "../image-type";
import type { StoreTx } from "../store-inbound";
import type { SupportFile } from "./messages";
import { cleanLine } from "./text";

// Files arrive before the message they belong to is stored. Until it is, each has a row in
// `uploads`, and whoever deletes that row decides: the message's transaction keeps the file,
// anything else deletes it. Maintenance deletes what a crash left behind.

const UPLOAD_TTL_MS = 60 * 60 * 1000;

/** A name to show: no path, no control characters, no trailing dots that hide an extension. */
export function cleanFilename(name: string) {
  const last = cleanLine(name).split(/[/\\]/).at(-1) ?? "";
  // Bidi marks can make "gpj.exe" read as "exe.jpg".
  const clean = last.replace(/[‎‏‪-‮⁦-⁩]/g, "").replace(/[.\s]+$/, "").trim();
  if (clean.length <= 200) return clean || "file";
  const extension = /\.[^.]{1,20}$/.exec(clean)?.[0] ?? "";
  return clean.slice(0, 200 - extension.length) + extension;
}

// What it claims, unless that's an image: those are only believed from their bytes.
function checkedType(start: Uint8Array, claimed: string) {
  const image = imageInfo(start)?.type;
  if (image) return image;
  const type = claimed.split(";")[0]!.trim().toLowerCase();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]{1,100}$/.test(type) && !type.startsWith("image/") ? type : "application/octet-stream";
}

function meter() {
  const hash = createHash("sha256");
  const start: Buffer[] = [];
  let size = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      if (size < IMAGE_HEADER_BYTES) start.push(chunk.subarray(0, IMAGE_HEADER_BYTES - size));
      size += chunk.length;
      done(null, chunk);
    },
  });
  return { stream, result: () => ({ size, hash: hash.digest("hex"), start: new Uint8Array(Buffer.concat(start)) }) };
}

export interface IncomingFile {
  filename: string;
  contentType: string;
  body: Readable;
}

/** Puts a file in storage without writing it anywhere else. */
export async function storeSupportFile(workspaceId: string, messageId: string, file: IncomingFile): Promise<SupportFile> {
  const filename = cleanFilename(file.filename);
  const uploadId = crypto.randomUUID();
  const storageKey = messageKey(workspaceId, messageId, uploadId);
  await getDb().insert(uploads).values({
    id: uploadId, workspaceId, storageKey, filename, size: 0, contentType: "application/octet-stream",
    expiresAt: new Date(Date.now() + UPLOAD_TTL_MS),
  });
  const { stream, result } = meter();
  const stored = streamToStorage(storageKey, stream, "application/octet-stream").catch((error: Error) => {
    stream.destroy(error);
    throw error;
  });
  // Both have to be over before deleting, or a late write would bring the file back.
  const [read, written] = await Promise.allSettled([pipeline(file.body, stream), stored]);
  if (read.status === "rejected" || written.status === "rejected") {
    await discardFiles([uploadId]);
    throw read.status === "rejected" ? read.reason : (written as PromiseRejectedResult).reason;
  }
  const { size, hash, start } = result();
  return { uploadId, storageKey, filename, contentType: checkedType(start, file.contentType), size, hash };
}

/** Reads a file only to compare it with one that's already stored. */
export async function hashSupportFile(file: IncomingFile) {
  const hash = createHash("sha256");
  for await (const chunk of file.body) hash.update(chunk as Buffer);
  return { filename: cleanFilename(file.filename), hash: hash.digest("hex") };
}

/** Keeps the files, as part of storing their message. */
export async function claimFiles(tx: StoreTx, files: SupportFile[]) {
  const claimed = await tx
    .delete(uploads)
    .where(and(inArray(uploads.id, files.map((file) => file.uploadId)), eq(uploads.status, "pending")))
    .returning({ id: uploads.id });
  if (claimed.length !== files.length) throw new Error("A file was cleaned up before its message was stored");
}

/** Deletes files whose message wasn't stored. Those it was stored with stay. */
export async function discardFiles(uploadIds: string[]) {
  if (!uploadIds.length) return;
  const gone = await getDb()
    .select({ id: uploads.id, key: uploads.storageKey })
    .from(uploads)
    .where(inArray(uploads.id, uploadIds));
  await Promise.all(
    gone.map(async ({ id, key }) => {
      // Locks the row, so a message still being stored with it can't keep a deleted file.
      await getDb().transaction(async (tx) => {
        const [row] = await tx.delete(uploads).where(eq(uploads.id, id)).returning({ id: uploads.id });
        if (row) await deleteObject(key);
      });
    }),
  ).catch((error: unknown) => console.error("[support] Couldn't delete unused files, maintenance will:", error));
}
