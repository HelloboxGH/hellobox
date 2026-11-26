import { isStorageConfigured } from "@hellobox/config";
import { entitlementsFor } from "@hellobox/extensions";
import {
  cleanFilename,
  discardFiles,
  earlierResult,
  hashSupportFile,
  idempotencyKeyUsed,
  isRiskyAttachment,
  type PostResult,
  storeSupportFile,
  type SupportFile,
  type SupportInbox,
  type SupportMessage,
  type SupportUpload,
} from "@hellobox/mail";
import { assertLength, MAX_JSON_BYTES, SupportError } from "./http";
import { MultipartError, type MultipartLimits, type MultipartPart, readMultipart } from "./multipart";

const MB = 1024 * 1024;
const MAX_FILES = 5;
const MAX_FILE_BYTES = 10 * MB;
const MAX_FILES_BYTES = 20 * MB;
const MAX_BODY_BYTES = MAX_FILES_BYTES + MAX_JSON_BYTES + 64 * 1024;

export const UPLOAD_LIMITS: MultipartLimits = {
  totalBytes: MAX_BODY_BYTES,
  fileBytes: MAX_FILE_BYTES,
  files: MAX_FILES,
  fields: 1,
  fieldBytes: MAX_JSON_BYTES,
  timeoutMs: 120_000,
  idleMs: 20_000,
};

const tooLarge = () => new SupportError(413, "too_large", `A message can have ${MAX_FILES} files, ${MAX_FILE_BYTES / MB} MB each and ${MAX_FILES_BYTES / MB} MB together`);

export const assertUploadLength = (request: Request) => assertLength(request, MAX_BODY_BYTES, tooLarge);

const storageFull = () => new SupportError(409, "storage_full", "This workspace's storage is full. Send the message again without files");

function fromMultipart(error: unknown) {
  if (!(error instanceof MultipartError)) return error;
  switch (error.kind) {
    case "timeout":
      return new SupportError(408, "invalid_request", error.message);
    case "too-large":
    case "too-many":
      return new SupportError(413, "too_large", `${error.message}. ${tooLarge().message}`);
    default:
      return new SupportError(400, "invalid_request", error.message);
  }
}

export interface Receiving {
  parse: (json: string) => SupportMessage;
  // Counts the customer's message, once it's known whose it is and that it isn't a retry.
  limit: (message: SupportMessage) => Promise<void>;
  post: (message: SupportMessage, upload: SupportUpload) => Promise<PostResult>;
  // Says why a file isn't taken, if it isn't.
  refuse?: (file: SupportFile) => string | undefined;
  limits?: MultipartLimits;
}

function checkFile(part: Extract<MultipartPart, { kind: "file" }>) {
  const filename = cleanFilename(part.filename);
  if (!isRiskyAttachment(filename)) return;
  throw new SupportError(422, "unsafe_file", `${filename} wasn't accepted: files of this kind can run programs. Send it in another format`);
}

/** Reads a message and then its files, stores the files, and stores the message with them. */
export async function receiveWithFiles(row: SupportInbox, request: Request, receiving: Receiving): Promise<PostResult> {
  if (!request.body) throw new SupportError(400, "invalid_request", "The body is empty");
  const { workspaceId } = row.inbox;
  const messageId = crypto.randomUUID();
  const files: SupportFile[] = [];
  const hashes: { filename: string; hash: string }[] = [];
  let message: SupportMessage | undefined;
  let repeat = false;
  let kept = false;
  const room = (await entitlementsFor(workspaceId)).limits.storageBytes - row.workspace.storageBytesUsed;
  try {
    for await (const part of readMultipart(request.body, request.headers.get("content-type") ?? "", receiving.limits ?? UPLOAD_LIMITS)) {
      if (part.kind === "field") {
        if (part.name !== "message") throw new SupportError(400, "invalid_request", "Send the JSON in a field named message, then the files in files");
        message = receiving.parse(part.value);
        repeat = await idempotencyKeyUsed(row, message.idempotencyKey);
        if (!repeat) await receiving.limit(message);
        continue;
      }
      if (!message) throw new SupportError(400, "invalid_request", "The message field has to come before the files");
      if (part.name !== "files") throw new SupportError(400, "invalid_request", "Send the files in fields named files");
      checkFile(part);
      if (repeat) {
        hashes.push(await hashSupportFile(part));
        continue;
      }
      if (!isStorageConfigured()) throw new SupportError(409, "unavailable", "This HelloBox has no file storage. Send the message again without files");
      if (room <= 0) throw storageFull();
      const file = await storeSupportFile(workspaceId, messageId, part);
      files.push(file);
      const refused = receiving.refuse?.(file);
      if (refused) throw new SupportError(422, "unsafe_file", refused);
      const total = files.reduce((sum, { size }) => sum + size, 0);
      if (total > MAX_FILES_BYTES) throw tooLarge();
      if (total > room) throw storageFull();
    }
    if (!message) throw new SupportError(400, "invalid_request", "The message field is missing");
    if (repeat) {
      const earlier = await earlierResult(row, message, hashes);
      // Deleted in between. Nothing was kept, so the next try starts over.
      if (!earlier) throw new Error("The earlier message is gone");
      return earlier;
    }
    const result = await receiving.post(message, { messageId, files });
    kept = result.status === "stored";
    return result;
  } catch (error) {
    throw fromMultipart(error);
  } finally {
    // When storing failed halfway, this keeps the files of a message that did get in.
    if (!kept) await discardFiles(files.map((file) => file.uploadId));
  }
}
