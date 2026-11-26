import type { Readable } from "node:stream";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getStorageEnv } from "@hellobox/config";

const PART_SIZE = 8 * 1024 * 1024;
const URL_TTL_SECONDS = 15 * 60;

let client: S3Client | undefined;
let signer: S3Client | undefined;

function makeClient(endpoint: string | undefined, signing = false) {
  const env = getStorageEnv();
  return new S3Client({
    region: env.region,
    endpoint,
    forcePathStyle: env.forcePathStyle,
    // Signed links are filled in later by a browser. By default the SDK writes the checksum
    // of an empty body into an upload link, and a strict S3 server then rejects the part.
    // R2 never minded, so its links stay as they were.
    ...(signing && env.kind === "s3" ? { requestChecksumCalculation: "WHEN_REQUIRED" as const } : {}),
    credentials: { accessKeyId: env.accessKeyId, secretAccessKey: env.secretAccessKey },
  });
}

function s3() {
  client ??= makeClient(getStorageEnv().endpoint);
  return client;
}

// Signing doesn't touch the network, so links can name an address the server itself can't
// reach (the one browsers use), while reads and writes use the internal one.
function presigner() {
  signer ??= makeClient(getStorageEnv().publicEndpoint ?? getStorageEnv().endpoint, true);
  return signer;
}

const bucket = () => getStorageEnv().bucket;

export const messageKey = (workspaceId: string, messageId: string, id: string) =>
  `workspaces/${workspaceId}/messages/${messageId}/${id}`;
export const avatarKey = (userId: string, file: string) => `avatars/${userId}/${file}`;
// The creators app has its own accounts, so its photos live apart from the main app's.
export const creatorAvatarKey = (userId: string, file: string) => `creators/avatars/${userId}/${file}`;
export const logoKey = (workspaceId: string, file: string) => `logos/${workspaceId}/${file}`;
export const draftKey = (workspaceId: string, uploadId: string) =>
  `drafts/${workspaceId}/${uploadId}`;
// Mail a provider pushed to us, kept until ingest has stored it properly. Under the
// workspace, so deleting the workspace deletes it too.
export const inboundKey = (workspaceId: string, connectionId: string, emailId: string) =>
  `workspaces/${workspaceId}/inbound/${connectionId}/${emailId}.eml`;

// Streams with bounded memory: at most queueSize parts are buffered at once.
export async function streamToStorage(
  key: string,
  body: ReadableStream<Uint8Array> | Readable,
  contentType: string,
) {
  await new Upload({
    client: s3(),
    params: {
      Bucket: bucket(),
      Key: key,
      Body: body as Readable,
      ContentType: contentType,
    },
    partSize: PART_SIZE,
    queueSize: 2,
  }).done();
}

export async function putObject(key: string, body: Uint8Array, contentType: string) {
  await s3().send(
    new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: contentType }),
  );
}

export async function objectSize(key: string) {
  const head = await s3().send(
    new HeadObjectCommand({ Bucket: bucket(), Key: key }),
  );
  return head.ContentLength ?? 0;
}

export async function deleteObject(key: string) {
  await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}

export const workspacePrefixes = (workspaceId: string) => [
  `workspaces/${workspaceId}/`,
  `drafts/${workspaceId}/`,
  `logos/${workspaceId}/`,
];

export async function deletePrefix(prefix: string) {
  let token: string | undefined;
  do {
    const page = await s3().send(
      new ListObjectsV2Command({ Bucket: bucket(), Prefix: prefix, ContinuationToken: token }),
    );
    const objects = (page.Contents ?? []).flatMap((item) => (item.Key ? [{ Key: item.Key }] : []));
    if (objects.length) {
      await s3().send(new DeleteObjectsCommand({ Bucket: bucket(), Delete: { Objects: objects } }));
    }
    token = page.NextContinuationToken;
  } while (token);
}

// One page of keys under a prefix, oldest first by name order.
export async function listKeys(prefix: string, next?: string) {
  const page = await s3().send(
    new ListObjectsV2Command({ Bucket: bucket(), Prefix: prefix, ContinuationToken: next, MaxKeys: 100 }),
  );
  return {
    keys: (page.Contents ?? []).flatMap((item) => (item.Key ? [item.Key] : [])),
    next: page.IsTruncated ? page.NextContinuationToken : undefined,
  };
}

export async function readObject(key: string) {
  const res = await s3().send(
    new GetObjectCommand({ Bucket: bucket(), Key: key }),
  );
  if (!res.Body) throw new Error(`Empty object: ${key}`);
  return res.Body.transformToWebStream();
}

/** The first bytes of a file, to see what it really is. */
export async function readStart(key: string, bytes: number) {
  const res = await s3().send(
    new GetObjectCommand({ Bucket: bucket(), Key: key, Range: `bytes=0-${bytes - 1}` }),
  );
  return res.Body ? res.Body.transformToByteArray() : new Uint8Array();
}

const PREVIEW_TTL_SECONDS = 5 * 60;

/**
 * For an <img>, with the type read from the file's own bytes. Opened on its own it's still a
 * download, so it's never a page on the storage host, whatever headers that sends.
 */
export function signedPreviewUrl(key: string, imageType: "image/png" | "image/jpeg" | "image/gif" | "image/webp") {
  return getSignedUrl(
    presigner(),
    new GetObjectCommand({
      Bucket: bucket(),
      Key: key,
      ResponseContentDisposition: "attachment",
      ResponseContentType: imageType,
    }),
    { expiresIn: PREVIEW_TTL_SECONDS },
  );
}

export function signedDownloadUrl(
  key: string,
  filename: string,
  contentType: string,
) {
  // Attachments are untrusted: always a download, with a neutral type for active content.
  const safeName = filename.replace(/["\\\r\n]/g, "_");
  const inlineSafe = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain)$/i.test(
    contentType,
  );
  return getSignedUrl(
    presigner(),
    new GetObjectCommand({
      Bucket: bucket(),
      Key: key,
      ResponseContentDisposition: `attachment; filename="${safeName}"`,
      ResponseContentType: inlineSafe ? contentType : "application/octet-stream",
    }),
    { expiresIn: URL_TTL_SECONDS },
  );
}

export function signedSendUrl(key: string) {
  return getSignedUrl(
    presigner(),
    new GetObjectCommand({ Bucket: bucket(), Key: key }),
    { expiresIn: URL_TTL_SECONDS },
  );
}

export async function startMultipartUpload(key: string, contentType: string) {
  const res = await s3().send(
    new CreateMultipartUploadCommand({
      Bucket: bucket(),
      Key: key,
      ContentType: contentType,
    }),
  );
  if (!res.UploadId) throw new Error("The storage server did not return an upload id");
  return { uploadId: res.UploadId, partSize: PART_SIZE };
}

export function signedPartUrl(key: string, uploadId: string, partNumber: number) {
  return getSignedUrl(
    presigner(),
    new UploadPartCommand({
      Bucket: bucket(),
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
    }),
    { expiresIn: URL_TTL_SECONDS },
  );
}

export async function completeMultipartUpload(
  key: string,
  uploadId: string,
  parts: { partNumber: number; etag: string }[],
) {
  await s3().send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket(),
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: parts.map((part) => ({
          PartNumber: part.partNumber,
          ETag: part.etag,
        })),
      },
    }),
  );
}

export async function abortMultipartUpload(key: string, uploadId: string) {
  await s3().send(
    new AbortMultipartUploadCommand({
      Bucket: bucket(),
      Key: key,
      UploadId: uploadId,
    }),
  );
}
