import { getExtensions } from "@/core/extensions";
import {
  domains,
  drafts,
  getDb,
  mailboxes,
  messages,
  outbox,
  threads,
  uploads,
  workspaces,
} from "@hellobox/db";
import { MAX_ATTACHMENT_BYTES, parseAddress, sandboxBlockedRecipients, sanitizeEmailHtml, sendBlockedReason, suppressedAmong, suppressionWhy } from "@hellobox/mail";
import { enqueueSend, getMailQueue, sendJobId } from "@hellobox/queue";
import {
  abortMultipartUpload,
  completeMultipartUpload,
  deleteObject,
  draftKey,
  objectSize,
  signedPartUrl,
  startMultipartUpload,
} from "@hellobox/storage";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { badRequest, conflict, notFound } from "nezt";
import { z } from "zod";
import { roomError } from "../entitlements";
import { workspaceAction } from "../builder";
import { assertMailboxAccess, type WorkspaceContext } from "../middlewares";

const UNDO_WINDOW_MS = 10_000;
const addressList = z.array(z.email()).max(50);

const composeFields = {
  mailboxId: z.string(),
  threadId: z.string().nullable().optional(),
  replyToMessageId: z.string().nullable().optional(),
  to: addressList.default([]),
  cc: addressList.default([]),
  bcc: addressList.default([]),
  subject: z.string().max(998).default(""),
  html: z.string().max(1_500_000).default(""),
  uploadIds: z.array(z.string()).max(20).default([]),
};

async function assertThreadInMailbox(
  ctx: WorkspaceContext,
  mailboxId: string,
  threadId?: string | null,
  replyToMessageId?: string | null,
) {
  if (threadId) {
    const [thread] = await getDb()
      .select({ id: threads.id })
      .from(threads)
      .where(and(eq(threads.id, threadId), eq(threads.mailboxId, mailboxId)));
    if (!thread) throw notFound("Conversation");
  }
  if (replyToMessageId) {
    const [message] = await getDb()
      .select({ threadId: messages.threadId })
      .from(messages)
      .where(
        and(eq(messages.id, replyToMessageId), eq(messages.workspaceId, ctx.workspace.id)),
      );
    if (!message || message.threadId !== threadId) throw notFound("Message");
  }
}

export const saveDraft = workspaceAction("/drafts/save")
  .input(z.object({ id: z.string().optional(), ...composeFields }))
  .handler(async ({ input, ctx }) => {
    await assertMailboxAccess(ctx, input.mailboxId);
    await assertThreadInMailbox(ctx, input.mailboxId, input.threadId, input.replyToMessageId);
    const values = {
      mailboxId: input.mailboxId,
      threadId: input.threadId ?? null,
      replyToMessageId: input.replyToMessageId ?? null,
      toRecipients: input.to,
      ccRecipients: input.cc,
      bccRecipients: input.bcc,
      subject: input.subject,
      html: input.html,
      uploadIds: input.uploadIds,
    };
    const db = getDb();
    if (input.id) {
      const [updated] = await db
        .update(drafts)
        .set(values)
        .where(
          and(
            eq(drafts.id, input.id),
            eq(drafts.workspaceId, ctx.workspace.id),
            eq(drafts.userId, ctx.user.id),
          ),
        )
        .returning({ id: drafts.id });
      if (!updated) throw notFound("Draft");
      return updated;
    }
    const [created] = await db
      .insert(drafts)
      .values({ ...values, workspaceId: ctx.workspace.id, userId: ctx.user.id })
      .returning({ id: drafts.id });
    return created as { id: string };
  });

export const listDrafts = workspaceAction("/drafts/list").handler(async ({ ctx }) =>
  getDb()
    .select()
    .from(drafts)
    .where(and(eq(drafts.workspaceId, ctx.workspace.id), eq(drafts.userId, ctx.user.id)))
    .orderBy(desc(drafts.updatedAt))
    .limit(100),
);

export const deleteDraft = workspaceAction("/drafts/delete")
  .input(z.object({ id: z.string() }))
  .handler(async ({ input, ctx }) => {
    await getDb()
      .delete(drafts)
      .where(
        and(
          eq(drafts.id, input.id),
          eq(drafts.workspaceId, ctx.workspace.id),
          eq(drafts.userId, ctx.user.id),
        ),
      );
    return { ok: true };
  });

// Lets the composer warn before Send about recipients a sandboxed SES account can't reach,
// and about addresses that bounced permanently or reported mail as spam.
export const checkRecipients = workspaceAction("/mail/check-recipients")
  .input(z.object({ mailboxId: z.string(), recipients: z.array(z.string()).max(200) }))
  .handler(async ({ input, ctx }) => {
    await assertMailboxAccess(ctx, input.mailboxId);
    const [blocked, suppressed] = await Promise.all([
      sandboxBlockedRecipients(input.mailboxId, input.recipients),
      suppressedAmong(ctx.workspace.id, input.recipients),
    ]);
    return { blocked, suppressed: suppressed.map((row) => ({ email: row.email, why: suppressionWhy(row) })) };
  });

// sendAt in the future is a scheduled send. Otherwise a short delay gives undo.
export const sendMessage = workspaceAction("/mail/send")
  .input(
    z.object({
      draftId: z.string().optional(),
      sendAt: z.iso.datetime().optional(),
      // The person saw why these addresses are suppressed and chose to send anyway.
      allowSuppressed: z.boolean().optional(),
      ...composeFields,
    }),
  )
  .handler(async ({ input, ctx }) => {
    await assertMailboxAccess(ctx, input.mailboxId);
    await assertThreadInMailbox(ctx, input.mailboxId, input.threadId, input.replyToMessageId);
    if (!input.to.length && !input.cc.length && !input.bcc.length) {
      throw badRequest("Add at least one recipient");
    }
    const [sender] = await getDb()
      .select({ mailboxRemovedAt: mailboxes.removedAt, isCatchAll: mailboxes.isCatchAll, domainRemovedAt: domains.removedAt })
      .from(mailboxes)
      .innerJoin(domains, eq(domains.id, mailboxes.domainId))
      .where(eq(mailboxes.id, input.mailboxId));
    const stopped = sender && sendBlockedReason({ removedAt: sender.mailboxRemovedAt, isCatchAll: sender.isCatchAll }, { removedAt: sender.domainRemovedAt });
    if (stopped) throw badRequest(stopped);
    // A sandbox (the public demo) answers right away instead of failing in the outbox later.
    const refusal = await getExtensions().mail?.beforeSend?.({
      sandbox: Boolean(ctx.workspace.demoExpiresAt),
      workspaceId: ctx.workspace.id,
      mailboxId: input.mailboxId,
      recipients: [...input.to, ...input.cc, ...input.bcc].map((value) => parseAddress(value).address),
      hasAttachments: input.uploadIds.length > 0,
    });
    if (refusal) throw badRequest(refusal);
    const blocked = await sandboxBlockedRecipients(input.mailboxId, [...input.to, ...input.cc, ...input.bcc]);
    if (blocked.length) {
      throw badRequest(
        `Your Amazon SES account is in the sandbox, so it can't send to ${blocked.join(", ")} yet. Add them as test recipients in settings, or request production access.`,
      );
    }
    if (!input.allowSuppressed) {
      const suppressed = await suppressedAmong(ctx.workspace.id, [...input.to, ...input.cc, ...input.bcc]);
      if (suppressed.length) {
        throw badRequest(
          `Not sent: ${suppressed.map(suppressionWhy).join("; ")}. Send anyway from the composer, or remove the address from Settings → Suppressed addresses.`,
        );
      }
    }
    const db = getDb();
    if (input.uploadIds.length) {
      const files = await db
        .select({ status: uploads.status })
        .from(uploads)
        .where(and(inArray(uploads.id, input.uploadIds), eq(uploads.workspaceId, ctx.workspace.id)));
      if (files.length !== input.uploadIds.length || files.some((f) => f.status === "pending")) {
        throw badRequest("An attachment hasn't finished uploading");
      }
    }
    const sendAt = input.sendAt ? new Date(input.sendAt) : new Date(Date.now() + UNDO_WINDOW_MS);
    if (input.sendAt && sendAt.getTime() < Date.now()) {
      throw badRequest("Pick a time in the future");
    }
    const [item] = await db
      .insert(outbox)
      .values({
        workspaceId: ctx.workspace.id,
        userId: ctx.user.id,
        mailboxId: input.mailboxId,
        threadId: input.threadId ?? null,
        replyToMessageId: input.replyToMessageId ?? null,
        toRecipients: input.to,
        ccRecipients: input.cc,
        bccRecipients: input.bcc,
        subject: input.subject,
        html: sanitizeEmailHtml(input.html),
        uploadIds: input.uploadIds,
        sendAt,
        agentTokenId: ctx.agent?.tokenId ?? null,
      })
      .returning({ id: outbox.id, sendAt: outbox.sendAt });
    if (!item) throw new Error("Could not queue the email");
    try {
      await enqueueSend(item.id, sendAt.getTime() - Date.now());
    } catch (error) {
      // Without a job it would never send, so it mustn't look scheduled.
      await db.delete(outbox).where(eq(outbox.id, item.id));
      throw error;
    }
    if (input.uploadIds.length) {
      await db.update(uploads).set({ status: "attached" }).where(inArray(uploads.id, input.uploadIds));
    }
    if (input.draftId) {
      await db
        .delete(drafts)
        .where(
          and(
            eq(drafts.id, input.draftId),
            eq(drafts.workspaceId, ctx.workspace.id),
            eq(drafts.userId, ctx.user.id),
          ),
        );
    }
    return item;
  });

export const cancelSend = workspaceAction("/mail/cancel")
  .input(z.object({ id: z.string() }))
  .handler(async ({ input, ctx }) => {
    const [canceled] = await getDb()
      .update(outbox)
      .set({ status: "canceled" })
      .where(
        and(
          eq(outbox.id, input.id),
          eq(outbox.workspaceId, ctx.workspace.id),
          eq(outbox.status, "scheduled"),
        ),
      )
      .returning();
    if (!canceled) throw conflict("This email has already been sent");
    await getMailQueue().remove(sendJobId(input.id));
    return {
      mailboxId: canceled.mailboxId,
      threadId: canceled.threadId,
      replyToMessageId: canceled.replyToMessageId,
      to: canceled.toRecipients,
      cc: canceled.ccRecipients,
      bcc: canceled.bccRecipients,
      subject: canceled.subject,
      html: canceled.html,
      uploadIds: canceled.uploadIds,
    };
  });

// Skips the rest of the undo window. Only the sender can do it, while it's still waiting.
export const sendNow = workspaceAction("/mail/send-now")
  .input(z.object({ id: z.string() }))
  .handler(async ({ input, ctx }) => {
    const [item] = await getDb()
      .update(outbox)
      .set({ sendAt: new Date() })
      .where(
        and(
          eq(outbox.id, input.id),
          eq(outbox.workspaceId, ctx.workspace.id),
          eq(outbox.userId, ctx.user.id),
          eq(outbox.status, "scheduled"),
        ),
      )
      .returning({ id: outbox.id });
    if (!item) throw conflict("This email has already been sent");
    const job = await getMailQueue().getJob(sendJobId(input.id));
    if (job && (await job.isDelayed())) await job.promote();
    else if (!job) await enqueueSend(input.id);
    return { ok: true };
  });

export const listScheduled = workspaceAction("/mail/scheduled").handler(async ({ ctx }) =>
  getDb()
    .select()
    .from(outbox)
    .where(
      and(
        eq(outbox.workspaceId, ctx.workspace.id),
        eq(outbox.userId, ctx.user.id),
        inArray(outbox.status, ["scheduled", "failed"]),
      ),
    )
    .orderBy(outbox.sendAt)
    .limit(100),
);

export const startUpload = workspaceAction("/uploads/start")
  .input(
    z.object({
      filename: z.string().min(1).max(255),
      contentType: z.string().max(200),
      size: z.number().int().positive(),
    }),
  )
  .handler(async ({ input, ctx }) => {
    if (input.size > MAX_ATTACHMENT_BYTES) {
      throw badRequest("Attachments can be up to 30 MB");
    }
    if (ctx.workspace.storageBytesUsed + input.size > ctx.entitlements.limits.storageBytes) {
      throw roomError(ctx, "storageBytes", ctx.workspace.storageBytesUsed, "You've used all of your plan's storage");
    }
    const id = crypto.randomUUID();
    const storageKey = draftKey(ctx.workspace.id, id);
    const { uploadId, partSize } = await startMultipartUpload(storageKey, input.contentType);
    await getDb().insert(uploads).values({
      id,
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      storageKey,
      filename: input.filename,
      contentType: input.contentType,
      size: input.size,
      multipartUploadId: uploadId,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    const parts = Math.ceil(input.size / partSize);
    const urls = await Promise.all(
      Array.from({ length: parts }, (_, index) =>
        signedPartUrl(storageKey, uploadId, index + 1),
      ),
    );
    return { id, partSize, urls };
  });

export const completeUpload = workspaceAction("/uploads/complete")
  .input(
    z.object({
      id: z.string(),
      parts: z.array(z.object({ partNumber: z.number().int(), etag: z.string() })).min(1),
    }),
  )
  .handler(async ({ input, ctx }) => {
    const db = getDb();
    const [upload] = await db
      .select()
      .from(uploads)
      .where(and(eq(uploads.id, input.id), eq(uploads.workspaceId, ctx.workspace.id)));
    if (!upload?.multipartUploadId) throw notFound("Upload");
    await completeMultipartUpload(upload.storageKey, upload.multipartUploadId, input.parts);
    // The browser's declared size can't be trusted, so check what actually landed.
    const size = await objectSize(upload.storageKey);
    if (size > MAX_ATTACHMENT_BYTES) {
      await deleteObject(upload.storageKey);
      await db.delete(uploads).where(eq(uploads.id, upload.id));
      throw badRequest("Attachments can be up to 30 MB");
    }
    await db.update(uploads).set({ status: "ready", size }).where(eq(uploads.id, upload.id));
    await db
      .update(workspaces)
      .set({ storageBytesUsed: sql`${workspaces.storageBytesUsed} + ${size}` })
      .where(eq(workspaces.id, ctx.workspace.id));
    return { id: upload.id, filename: upload.filename, size };
  });

export const abortUpload = workspaceAction("/uploads/abort")
  .input(z.object({ id: z.string() }))
  .handler(async ({ input, ctx }) => {
    const db = getDb();
    const [upload] = await db
      .select()
      .from(uploads)
      .where(and(eq(uploads.id, input.id), eq(uploads.workspaceId, ctx.workspace.id)));
    if (!upload) return { ok: true };
    if (upload.multipartUploadId && upload.status === "pending") {
      await abortMultipartUpload(upload.storageKey, upload.multipartUploadId);
    } else {
      await deleteObject(upload.storageKey);
    }
    await db.delete(uploads).where(eq(uploads.id, upload.id));
    if (upload.status === "ready") {
      await db
        .update(workspaces)
        .set({ storageBytesUsed: sql`greatest(${workspaces.storageBytesUsed} - ${upload.size}, 0)` })
        .where(eq(workspaces.id, ctx.workspace.id));
    }
    return { ok: true };
  });

export const composeActions = {
  "/drafts/save": saveDraft,
  "/drafts/list": listDrafts,
  "/drafts/delete": deleteDraft,
  "/mail/send": sendMessage,
  "/mail/cancel": cancelSend,
  "/mail/check-recipients": checkRecipients,
  "/mail/send-now": sendNow,
  "/mail/scheduled": listScheduled,
  "/uploads/start": startUpload,
  "/uploads/complete": completeUpload,
  "/uploads/abort": abortUpload,
};

