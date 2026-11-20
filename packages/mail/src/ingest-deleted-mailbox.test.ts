import { expect, mock, test } from "bun:test";

// Runs the real ingest against Postgres and Redis, with file storage kept in memory. Skipped
// without DATABASE_URL and REDIS_URL.
import * as actualStorage from "@hellobox/storage";

const files = new Map<string, Uint8Array>();
const bytes = async (stream: ReadableStream<Uint8Array> | Uint8Array) =>
  stream instanceof Uint8Array ? stream : new Uint8Array(await new Response(stream).arrayBuffer());
mock.module("@hellobox/storage", () => ({
  ...actualStorage,
  streamToStorage: async (key: string, body: ReadableStream<Uint8Array> | Uint8Array) => { files.set(key, await bytes(body)); },
  objectSize: async (key: string) => files.get(key)?.length ?? 0,
  readObject: async (key: string) => {
    const file = files.get(key);
    if (!file) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
    return new Response(file).body!;
  },
  deleteObject: async (key: string) => { files.delete(key); },
}));

const { encrypt } = await import("@hellobox/config");
const { connections, domains, getDb, mailboxes, messages, threads, user, workspaces } = await import("@hellobox/db");
const { ingestEmail } = await import("./ingest");
const { eq } = await import("drizzle-orm");

const run = crypto.randomUUID().slice(0, 8);
const domainName = `acme-${run}.test`;

const raw = (to: string, subject: string, extra = "") =>
  new TextEncoder().encode(
    `From: Ada <ada@sender-${run}.test>\r\nTo: ${to}\r\nSubject: ${subject}\r\nDate: ${new Date().toUTCString()}\r\nMessage-ID: <${crypto.randomUUID()}@sender.test>\r\n${extra}Content-Type: text/plain\r\n\r\nHello\r\n`,
  );

test.skipIf(!process.env.DATABASE_URL || !process.env.REDIS_URL)("mail to a deleted mailbox is treated as mail to an unknown address", async () => {
  const db = getDb();
  const [owner] = await db.insert(user).values({ id: `u-${run}`, name: "Owner", email: `owner-${run}@x.test`, emailVerified: true }).returning();
  const [workspace] = await db.insert(workspaces).values({ name: `W ${run}` }).returning();
  const { members } = await import("@hellobox/db");
  await db.insert(members).values({ workspaceId: workspace!.id, userId: owner!.id, role: "owner" });
  const [connection] = await db.insert(connections).values({
    workspaceId: workspace!.id, provider: "mailgun", status: "active", accessTokenEnc: encrypt("key"),
    config: { mailgun: { region: "us", routes: { [domainName]: "route" } } } as never,
  }).returning();
  const [domain] = await db.insert(domains).values({
    workspaceId: workspace!.id, connectionId: connection!.id, providerDomainId: domainName, name: domainName,
    enabled: true, status: "active", sendingEnabled: true, receivingEnabled: true,
  }).returning();
  await db.insert(mailboxes).values({ workspaceId: workspace!.id, domainId: domain!.id, address: `live@${domainName}` });
  const [old] = await db.insert(mailboxes).values({ workspaceId: workspace!.id, domainId: domain!.id, address: `old@${domainName}`, removedAt: new Date() }).returning();
  // An old conversation in the deleted mailbox, to check a reply doesn't revive it.
  const [oldThread] = await db.insert(threads).values({ workspaceId: workspace!.id, mailboxId: old!.id, subject: "Earlier", folder: "inbox" }).returning();
  await db.insert(messages).values({ workspaceId: workspace!.id, threadId: oldThread!.id, direction: "inbound", fromAddress: `ada@sender-${run}.test`, messageIdHeader: "<earlier@sender.test>", subject: "Earlier" });

  const ingest = async (id: string, email: Uint8Array) => {
    files.set(actualStorage.inboundKey(workspace!.id, connection!.id, id), email);
    const result = await ingestEmail(connection!.id, id);
    if (result.status !== "ingested") return { result };
    const [thread] = await db.select().from(threads).where(eq(threads.id, result.threadId));
    const [message] = await db.select().from(messages).where(eq(messages.id, result.messageId));
    const [mailbox] = await db.select().from(mailboxes).where(eq(mailboxes.id, thread!.mailboxId));
    return { result, thread: thread!, message: message!, mailbox: mailbox! };
  };

  const live = await ingest(`live-${run}`, raw(`live@${domainName}`, "To a live mailbox"));
  expect(live.mailbox?.address).toBe(`live@${domainName}`);
  expect(live.thread?.folder).toBe("inbox");
  expect(live.thread?.expiresAt).toBeNull();

  const deleted = await ingest(`old-${run}`, raw(`old@${domainName}`, "To a deleted mailbox"));
  expect(deleted.mailbox?.isCatchAll).toBe(true);
  expect(deleted.thread?.folder).toBe("spam");
  expect(deleted.thread?.expiresAt).not.toBeNull();
  expect(deleted.message?.storageCounted).toBe(false);

  const reply = await ingest(`reply-${run}`, raw(`old@${domainName}`, "Re: Earlier", "In-Reply-To: <earlier@sender.test>\r\n"));
  expect(reply.thread?.id).not.toBe(oldThread!.id);
  expect(reply.mailbox?.isCatchAll).toBe(true);
  expect(reply.thread?.folder).toBe("spam");

  const [unchanged] = await db.select().from(threads).where(eq(threads.id, oldThread!.id));
  expect(unchanged?.messageCount).toBe(oldThread!.messageCount);
});
