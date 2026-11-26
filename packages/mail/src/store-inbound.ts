import {
  attachments,
  getDb,
  messages,
  threadLabels,
  threads,
  threadUserState,
  workspaces,
  type Address,
} from "@hellobox/db";
import { eq, sql } from "drizzle-orm";
import { QUARANTINE_HOURS } from "./flood";
import { normalizeSubject } from "./threading";

export type StoreTx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

type Thread = typeof threads.$inferSelect;
type Folder = Thread["folder"];

export function mergeParticipants(current: Address[], incoming: Address[]) {
  const merged = new Map(current.map((p) => [p.address, p]));
  for (const person of incoming) {
    if (!merged.get(person.address)?.name) merged.set(person.address, person);
  }
  return [...merged.values()].slice(0, 50);
}

// The message is already stored. Rolls the transaction back, so nothing changes.
export class DuplicateMessage extends Error {}

// A reply brings an archived conversation back, but Spam and Trash stay put.
const returnsFromArchive = (current: Folder, folder: Folder): Folder =>
  current === "archive" && folder === "inbox" ? "inbox" : current;

export interface InboundToStore {
  message: Omit<typeof messages.$inferInsert, "threadId"> & { id: string; sentAt: Date; subject: string; snippet: string };
  mailboxId: string;
  participants: Address[];
  // Already in storage, so that a failed download retries before anything is visible.
  files: (typeof attachments.$inferInsert)[];
  // Bytes the workspace's storage grows by.
  storedBytes: number;
  folder: Folder;
  category: Thread["category"];
  labelId?: string;
  // Kept on its own in Spam, uncounted, and deleted after a day unless someone keeps it.
  quarantined?: boolean;
  // The conversation it joins, or null to start one.
  findThread: () => Promise<string | null>;
  // Where a conversation it joins ends up.
  folderFor?: (current: Folder, folder: Folder) => Folder;
  // Anything else that has to be saved with the message, or not at all.
  within?: (tx: StoreTx, threadId: string) => Promise<void>;
}

// Writes a message that arrived, by email or from an app: its conversation, the message,
// its files, unread state and storage, all together. Returns null when the message was
// already there.
export async function storeInbound(input: InboundToStore) {
  const { message, participants, files, quarantined = false } = input;
  const folderFor = input.folderFor ?? returnsFromArchive;
  const { workspaceId, sentAt, subject, snippet } = message;
  return getDb()
    .transaction(async (tx) => {
      const found = await input.findThread();
      let id = found;
      if (id) {
        const [thread] = await tx.select().from(threads).where(eq(threads.id, id));
        const folder = thread ? folderFor(thread.folder, input.folder) : input.folder;
        await tx
          .update(threads)
          .set({
            snippet,
            participants: mergeParticipants(thread?.participants ?? [], participants),
            lastMessageAt: sql`greatest(${threads.lastMessageAt}, ${sentAt.toISOString()}::timestamptz)`,
            messageCount: sql`${threads.messageCount} + 1`,
            hasAttachments: sql`${threads.hasAttachments} or ${files.length > 0}`,
            folder,
            ...(thread?.folder === "trash" && folder !== "trash" ? { trashedAt: null } : {}),
          })
          .where(eq(threads.id, id));
      } else {
        const [created] = await tx
          .insert(threads)
          .values({
            workspaceId,
            mailboxId: input.mailboxId,
            subject,
            normalizedSubject: normalizeSubject(subject),
            snippet,
            participants: mergeParticipants([], participants),
            folder: input.folder,
            category: input.category,
            hasAttachments: files.length > 0,
            messageCount: 1,
            lastMessageAt: sentAt,
            expiresAt: quarantined ? new Date(Date.now() + QUARANTINE_HOURS * 3_600_000) : null,
          })
          .returning({ id: threads.id });
        id = created?.id ?? null;
      }
      if (!id) throw new Error("Could not create a thread");

      const [inserted] = await tx
        .insert(messages)
        .values({ ...message, threadId: id })
        .onConflictDoNothing()
        .returning({ id: messages.id });
      // Lost a race with a parallel job. Rolling back undoes the thread changes.
      if (!inserted) throw new DuplicateMessage();
      if (files.length) await tx.insert(attachments).values(files);
      if (input.labelId) {
        await tx.insert(threadLabels).values({ threadId: id, labelId: input.labelId }).onConflictDoNothing();
      }
      // A new message makes the conversation unread again for everyone.
      await tx
        .update(threadUserState)
        .set({ readAt: null, snoozedUntil: null })
        .where(eq(threadUserState.threadId, id));
      if (!quarantined) {
        await tx
          .update(workspaces)
          .set({ storageBytesUsed: sql`${workspaces.storageBytesUsed} + ${input.storedBytes}` })
          .where(eq(workspaces.id, workspaceId));
      }
      await input.within?.(tx, id);
      return id;
    })
    .catch((error: unknown) => {
      if (error instanceof DuplicateMessage) return null;
      throw error;
    });
}
