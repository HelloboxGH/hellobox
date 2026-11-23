import { domains, getDb, imports, mailboxes } from "@hellobox/db";
import { publishEvent } from "@hellobox/mail";
import { enqueueImport } from "@hellobox/queue";
import {
  abortMultipartUpload,
  completeMultipartUpload,
  deleteObject,
  objectSize,
  signedPartUrl,
  startMultipartUpload,
} from "@hellobox/storage";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { badRequest, conflict, forbidden, notFound } from "nezt";
import { z } from "zod";
import { roomError } from "../entitlements";
import { workspaceAction } from "../builder";
import { accessibleMailboxIds, assertMailboxAccess, type WorkspaceContext } from "../middlewares";

// Bringing mail over from Gmail (Takeout), Apple Mail, Thunderbird or anything else that
// exports MBOX or EML. The browser uploads the file straight to storage in parts; the
// worker reads it and files each email (packages/mail/src/import.ts).

// Storage takes up to 10,000 parts of 8 MB.
const MAX_IMPORT_BYTES = 50 * 1024 ** 3;
const PART_BATCH = 50;

const importKey = (workspaceId: string, importId: string) => `workspaces/${workspaceId}/imports/${importId}`;
const formatOf = (filename: string) => (/\.eml$/i.test(filename) ? "eml" : "mbox");

// The mailbox the mail goes into. An address with no mailbox gets one made for it that
// only this person reads, with no domain: it holds the imported mail until the domain is
// added, if ever (a Gmail address never will be).
async function targetMailbox(ctx: WorkspaceContext, input: { mailboxId?: string; address?: string }) {
  const db = getDb();
  if (input.mailboxId) {
    await assertMailboxAccess(ctx, input.mailboxId);
    return input.mailboxId;
  }
  const address = input.address!.toLowerCase();
  const [existing] = await db
    .select({ id: mailboxes.id, removedAt: mailboxes.removedAt })
    .from(mailboxes)
    .where(and(eq(mailboxes.workspaceId, ctx.workspace.id), eq(mailboxes.address, address)));
  if (existing) {
    if (!(await accessibleMailboxIds(ctx)).includes(existing.id)) {
      throw forbidden("That address already has a mailbox here that you can't read");
    }
    if (existing.removedAt) throw badRequest("That mailbox was deleted. Add it again in Settings first");
    return existing.id;
  }
  const domainName = address.slice(address.indexOf("@") + 1);
  const [ours] = await db
    .select({ id: domains.id })
    .from(domains)
    .where(and(eq(domains.workspaceId, ctx.workspace.id), eq(domains.name, domainName), isNull(domains.removedAt)));
  if (ours) {
    throw badRequest(
      ctx.role === "member"
        ? "That address is on one of this workspace's domains. Ask an admin to add the mailbox, then import into it"
        : "That address is on one of your domains. Add the mailbox in Settings, then import into it",
    );
  }
  const [created] = await db
    .insert(mailboxes)
    .values({
      workspaceId: ctx.workspace.id,
      domainId: null,
      address,
      displayName: ctx.user.name || null,
      personalUserId: ctx.user.id,
    })
    .onConflictDoNothing()
    .returning({ id: mailboxes.id });
  if (!created) throw conflict("That mailbox was just added. Try again");
  return created.id;
}

export const startImport = workspaceAction("/imports/start")
  .input(
    z
      .object({
        filename: z.string().min(1).max(255),
        size: z.number().int().positive(),
        mailboxId: z.string().optional(),
        address: z.email().optional(),
      })
      .refine((input) => Boolean(input.mailboxId) !== Boolean(input.address), "Choose a mailbox or enter an address"),
  )
  .handler(async ({ input, ctx }) => {
    if (input.size > MAX_IMPORT_BYTES) throw badRequest("Files can be up to 50 GB. Split the export into smaller files");
    if (ctx.workspace.storageBytesUsed >= ctx.entitlements.limits.storageBytes) {
      throw roomError(ctx, "storageBytes", ctx.workspace.storageBytesUsed, "You've used all of your plan's storage");
    }
    const mailboxId = await targetMailbox(ctx, input);
    const id = crypto.randomUUID();
    const storageKey = importKey(ctx.workspace.id, id);
    const { uploadId, partSize } = await startMultipartUpload(storageKey, "application/octet-stream");
    await getDb().insert(imports).values({
      id,
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      mailboxId,
      filename: input.filename,
      format: formatOf(input.filename),
      storageKey,
      multipartUploadId: uploadId,
      size: input.size,
    });
    return { id, mailboxId, partSize, parts: Math.ceil(input.size / partSize) };
  });

async function ownUpload(ctx: WorkspaceContext, id: string) {
  const [row] = await getDb()
    .select()
    .from(imports)
    .where(and(eq(imports.id, id), eq(imports.workspaceId, ctx.workspace.id), eq(imports.userId, ctx.user.id)));
  if (!row) throw notFound("Import");
  return row;
}

// Links are signed a batch at a time, since a big export has thousands of parts.
export const importPartUrls = workspaceAction("/imports/parts")
  .input(z.object({ id: z.string(), partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(PART_BATCH) }))
  .handler(async ({ input, ctx }) => {
    const row = await ownUpload(ctx, input.id);
    if (row.status !== "uploading" || !row.multipartUploadId) throw badRequest("This upload has finished");
    const urls = await Promise.all(
      input.partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await signedPartUrl(row.storageKey, row.multipartUploadId!, partNumber),
      })),
    );
    return { urls };
  });

export const completeImportUpload = workspaceAction("/imports/complete")
  .input(
    z.object({
      id: z.string(),
      parts: z.array(z.object({ partNumber: z.number().int(), etag: z.string() })).min(1).max(10_000),
    }),
  )
  .handler(async ({ input, ctx }) => {
    const db = getDb();
    const row = await ownUpload(ctx, input.id);
    if (row.status !== "uploading" || !row.multipartUploadId) throw badRequest("This upload has finished");
    await completeMultipartUpload(row.storageKey, row.multipartUploadId, input.parts);
    // The browser's size can't be trusted, so check what landed.
    const size = await objectSize(row.storageKey);
    if (size > MAX_IMPORT_BYTES) {
      await deleteObject(row.storageKey);
      await db.update(imports).set({ status: "failed", error: "Files can be up to 50 GB", finishedAt: new Date() }).where(eq(imports.id, row.id));
      throw badRequest("Files can be up to 50 GB");
    }
    await db.update(imports).set({ status: "queued", size, multipartUploadId: null }).where(eq(imports.id, row.id));
    await enqueueImport(row.id);
    return { ok: true };
  });

export const cancelImport = workspaceAction("/imports/cancel")
  .input(z.object({ id: z.string() }))
  .handler(async ({ input, ctx }) => {
    const db = getDb();
    const row = await ownUpload(ctx, input.id);
    if (!["uploading", "queued", "running"].includes(row.status)) return { ok: true };
    // Mail already imported stays. The worker stops at its next checkpoint.
    await db
      .update(imports)
      .set({ status: "cancelled", finishedAt: new Date(), multipartUploadId: null })
      .where(eq(imports.id, row.id));
    if (row.multipartUploadId) await abortMultipartUpload(row.storageKey, row.multipartUploadId).catch(() => undefined);
    else await deleteObject(row.storageKey).catch(() => undefined);
    await publishEvent(ctx.workspace.id, { type: "thread.updated" });
    return { ok: true };
  });

// This person's imports in this workspace, newest first, for progress.
export const listImports = workspaceAction("/imports/list").handler(async ({ ctx }) => {
  const rows = await getDb()
    .select({
      id: imports.id,
      filename: imports.filename,
      format: imports.format,
      size: imports.size,
      status: imports.status,
      bytesRead: imports.bytesRead,
      imported: imports.imported,
      skipped: imports.skipped,
      failed: imports.failed,
      error: imports.error,
      createdAt: imports.createdAt,
      finishedAt: imports.finishedAt,
      mailbox: mailboxes.address,
    })
    .from(imports)
    .innerJoin(mailboxes, eq(mailboxes.id, imports.mailboxId))
    .where(
      and(
        eq(imports.workspaceId, ctx.workspace.id),
        eq(imports.userId, ctx.user.id),
        // An upload abandoned in a closed tab is left out until it's cleaned up.
        inArray(imports.status, ["queued", "running", "done", "failed", "uploading"]),
      ),
    )
    .orderBy(desc(imports.createdAt))
    .limit(20);
  return { imports: rows };
});

export const importActions = {
  "/imports/start": startImport,
  "/imports/parts": importPartUrls,
  "/imports/complete": completeImportUpload,
  "/imports/cancel": cancelImport,
  "/imports/list": listImports,
};
