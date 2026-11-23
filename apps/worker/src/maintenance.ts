import {
  attachments,
  getDb,
  imports,
  messages,
  connections,
  threads,
  uploads,
  workspaces,
} from "@hellobox/db";
import { isStorageConfigured } from "@hellobox/config";
import { entitlementsFor, getExtensions } from "@hellobox/extensions";
import { activatePendingPostmarkInbound, completeDueTakeovers, markIfRoleRevoked, providerFor, syncDomains, workspacesWithPendingContacts } from "@hellobox/mail";
import { abortMultipartUpload, deleteObject, deletePrefix, objectSize, workspacePrefixes } from "@hellobox/storage";
import { and, eq, inArray, isNotNull, lt, or, sql } from "drizzle-orm";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const PURGE_BATCH = 200;

// Batches until nothing's left, so a flood's quarantined mail is gone on time.
async function purgeOldThreads() {
  for (let batch = 0; batch < 50; batch += 1) {
    if ((await purgeThreadBatch()) < PURGE_BATCH) return;
  }
}

async function purgeThreadBatch() {
  const db = getDb();
  const cutoff = new Date(Date.now() - RETENTION_MS);
  const expired = await db
    .select({ id: threads.id, workspaceId: threads.workspaceId })
    .from(threads)
    .where(
      or(
        and(eq(threads.folder, "trash"), lt(threads.trashedAt, cutoff)),
        and(eq(threads.folder, "spam"), lt(threads.lastMessageAt, cutoff)),
        // Quarantined mail nobody kept: to an address with no mailbox, or from a flood.
        lt(threads.expiresAt, new Date()),
      ),
    )
    .limit(PURGE_BATCH);
  if (!expired.length) return 0;
  const ids = expired.map((row) => row.id);
  const files = await db
    .select({ key: attachments.storageKey, size: attachments.size, workspaceId: attachments.workspaceId, counted: messages.storageCounted })
    .from(attachments)
    .innerJoin(messages, eq(messages.id, attachments.messageId))
    .where(inArray(messages.threadId, ids));
  const raws = await db
    .select({ key: messages.rawKey, size: messages.rawSize, workspaceId: messages.workspaceId, counted: messages.storageCounted })
    .from(messages)
    .where(inArray(messages.threadId, ids));
  await Promise.all(
    [...files.map((f) => f.key), ...raws.flatMap((r) => r.key ?? [])].map(deleteObject),
  );
  // Quarantined files never counted toward storage, so deleting them gives nothing back.
  const freed = new Map<string, number>();
  for (const row of [...files, ...raws]) {
    if (row.counted) freed.set(row.workspaceId, (freed.get(row.workspaceId) ?? 0) + row.size);
  }
  await db.transaction(async (tx) => {
    await tx.delete(threads).where(inArray(threads.id, ids));
    for (const [workspaceId, bytes] of freed) {
      await tx
        .update(workspaces)
        .set({ storageBytesUsed: sql`greatest(${workspaces.storageBytesUsed} - ${bytes}, 0)` })
        .where(eq(workspaces.id, workspaceId));
    }
  });
  return expired.length;
}

async function cleanAbandonedUploads() {
  const db = getDb();
  const stale = await db
    .select()
    .from(uploads)
    .where(and(inArray(uploads.status, ["pending", "ready"]), lt(uploads.expiresAt, new Date())))
    .limit(200);
  for (const upload of stale) {
    if (upload.status === "pending" && upload.multipartUploadId) {
      await abortMultipartUpload(upload.storageKey, upload.multipartUploadId).catch(() => undefined);
    } else {
      await deleteObject(upload.storageKey).catch(() => undefined);
    }
    await db.delete(uploads).where(eq(uploads.id, upload.id));
    if (upload.status === "ready") {
      await db
        .update(workspaces)
        .set({ storageBytesUsed: sql`greatest(${workspaces.storageBytesUsed} - ${upload.size}, 0)` })
        .where(eq(workspaces.id, upload.workspaceId));
    }
  }
}

// An import whose upload never finished (the tab was closed) is dropped after two days.
async function cleanAbandonedImports() {
  const db = getDb();
  const stale = await db
    .select({ id: imports.id, storageKey: imports.storageKey, multipartUploadId: imports.multipartUploadId })
    .from(imports)
    .where(and(eq(imports.status, "uploading"), lt(imports.createdAt, new Date(Date.now() - 2 * 24 * 60 * 60 * 1000))))
    .limit(200);
  for (const row of stale) {
    if (row.multipartUploadId) await abortMultipartUpload(row.storageKey, row.multipartUploadId).catch(() => undefined);
    await db
      .update(imports)
      .set({ status: "cancelled", multipartUploadId: null, finishedAt: new Date(), error: "The upload didn't finish" })
      .where(eq(imports.id, row.id));
  }
}

export async function purgeWorkspaceFiles(workspaceId: string) {
  if (!isStorageConfigured()) return;
  await Promise.all(workspacePrefixes(workspaceId).map(deletePrefix));
}

// Originals stored before their size was recorded don't count toward storage yet. This
// measures a batch per run until every one is counted.
async function countOldRawFiles() {
  const db = getDb();
  const pending = await db
    .select({ id: messages.id, key: messages.rawKey, workspaceId: messages.workspaceId })
    .from(messages)
    .where(and(isNotNull(messages.rawKey), eq(messages.rawSize, 0), eq(messages.storageCounted, true)))
    .limit(200);
  for (const message of pending) {
    if (!message.key) continue;
    const size = await objectSize(message.key).catch(() => null);
    if (!size) continue;
    await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(messages)
        .set({ rawSize: size })
        .where(and(eq(messages.id, message.id), eq(messages.rawSize, 0)))
        .returning({ id: messages.id });
      if (!updated) return;
      await tx
        .update(workspaces)
        .set({ storageBytesUsed: sql`${workspaces.storageBytesUsed} + ${size}` })
        .where(eq(workspaces.id, message.workspaceId));
    });
  }
}

export async function runMaintenance(
  enqueueBackfill: (connectionId: string) => Promise<unknown>,
  enqueueContactSync: (workspaceId: string) => Promise<unknown>,
) {
  const active = await getDb()
    .select({ connection: connections })
    .from(connections)
    .where(eq(connections.status, "active"));
  const withProviders = active.flatMap((row) => {
    try {
      return [{ ...row, provider: providerFor(row.connection) }];
    } catch (error) {
      console.error(`[maintenance] Skipping connection ${row.connection.id}:`, error);
      return [];
    }
  });
  await Promise.all(
    withProviders
      .filter(({ provider }) => provider.capabilities.backfill)
      .map(({ connection }) => enqueueBackfill(connection.id)),
  );
  // Mail that failed every webhook attempt, for providers that keep it for us.
  for (const { connection, provider } of withProviders) {
    if (!provider.retryFailedInbound) continue;
    await provider.retryFailedInbound().catch(async (error) => {
      await markIfRoleRevoked(connection.id, error);
      console.error(`[maintenance] Couldn't retry failed mail for ${connection.id}:`, error);
    });
  }
  // Receiving that waits for Postmark to see its MX record, after the quick retries ran out.
  for (const { connection } of withProviders.filter(({ connection }) => connection.config.postmark?.pendingInboundDomain)) {
    await activatePendingPostmarkInbound(connection.id).catch((error) => {
      console.error(`[maintenance] Couldn't turn on Postmark receiving for ${connection.id}:`, error);
    });
  }
  for (const { connection } of withProviders.filter(({ provider }) => provider.capabilities.refreshDomains)) {
    const domainLimit = (await entitlementsFor(connection.workspaceId)).limits.domains;
    await syncDomains(connection.id, connection.workspaceId, domainLimit).catch(async (error) => {
      await markIfRoleRevoked(connection.id, error);
      console.error(`[maintenance] Couldn't refresh domains for ${connection.id}:`, error);
    });
  }
  // Cloud's extra upkeep (catching up with the payment provider), run here, before the
  // jobs below, as billing's own reconcile always did.
  for (const run of getExtensions().jobs.maintenance ?? []) await run({ purgeWorkspaceFiles });
  // Domain claims whose 7-day notice has ended (after the sync above, so they see fresh
  // provider verification).
  await completeDueTakeovers().catch((error) => console.error("[maintenance] Couldn't finish domain claims:", error));
  const pending = await workspacesWithPendingContacts();
  await Promise.all(pending.map((workspaceId) => enqueueContactSync(workspaceId)));
  if (isStorageConfigured()) {
    await purgeOldThreads();
    await cleanAbandonedUploads();
    await cleanAbandonedImports();
    await countOldRawFiles();
  }
}
