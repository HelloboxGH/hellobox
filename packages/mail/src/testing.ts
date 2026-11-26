import { mock, setDefaultTimeout } from "bun:test";
import { setting } from "@hellobox/config";
import { getDb, connections, domains, mailboxes, mailboxMembers, members, user, workspaces } from "@hellobox/db";
import { install, type Extensions } from "@hellobox/extensions";
import { type InboundEmail, type MailProvider, type OutgoingMessage, parseRawEmail } from "@hellobox/providers";
import * as actualStorage from "@hellobox/storage";

// For tests that run against a real Postgres and Redis: file storage kept in memory, and an
// email provider that takes mail from a map and only remembers what it was asked to send.
// They're skipped without DATABASE_URL and REDIS_URL. Other tests replace the database for
// their whole process, so run these with `--isolate`.

export const hasServices = Boolean(setting("DATABASE_URL") && setting("REDIS_URL"));

// The scanner's score depends on the network, so here nothing is spam by content.
if (hasServices) {
  setDefaultTimeout(60_000);
  const real = globalThis.fetch;
  globalThis.fetch = Object.assign(
    (...args: Parameters<typeof fetch>) => (String(args[0]).endsWith("/checkv2") ? Promise.resolve(Response.json({ score: 0 })) : real(...args)),
    { preconnect: real.preconnect },
  );
}

// A skipped describe still runs its body, where there may be no database to open.
export const testDb = () => (hasServices ? getDb() : (undefined as never));

export const storedFiles = new Map<string, Uint8Array>();
const bytes = async (body: unknown) => new Uint8Array(await new Response(body as ReadableStream).arrayBuffer());

/** Call before importing the code under test. */
export function memoryStorage() {
  mock.module("@hellobox/storage", () => ({
    ...actualStorage,
    streamToStorage: async (key: string, body: unknown) => { storedFiles.set(key, await bytes(body)); },
    putObject: async (key: string, body: Uint8Array) => { storedFiles.set(key, body); },
    objectSize: async (key: string) => storedFiles.get(key)?.length ?? 0,
    readObject: async (key: string) => {
      const file = storedFiles.get(key);
      if (!file) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
      return new Response(file as unknown as ReadableStream).body!;
    },
    deleteObject: async (key: string) => { storedFiles.delete(key); },
  }));
}

export interface TestMail {
  to: string;
  from: string;
  subject: string;
  text?: string;
  // Extra header lines, each ending in \r\n.
  headers?: string;
  messageId?: string;
  attachment?: { filename: string; content: string };
}

export function rawMail(mail: TestMail) {
  const head = `From: ${mail.from}\r\nTo: ${mail.to}\r\nSubject: ${mail.subject}\r\nDate: ${new Date().toUTCString()}\r\nMessage-ID: ${mail.messageId ?? `<${crypto.randomUUID()}@sender.test>`}\r\n${mail.headers ?? ""}`;
  const text = `Content-Type: text/plain\r\n\r\n${mail.text ?? "Hello"}\r\n`;
  const body = mail.attachment
    ? `MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=b1\r\n\r\n--b1\r\n${text}--b1\r\nContent-Type: application/octet-stream; name="${mail.attachment.filename}"\r\nContent-Disposition: attachment; filename="${mail.attachment.filename}"\r\n\r\n${mail.attachment.content}\r\n--b1--\r\n`
    : text;
  return new TextEncoder().encode(head + body);
}

/** A workspace with a shared mailbox on a domain whose provider is the one below. */
export async function testWorkspace(extensions: Extensions = {}) {
  const run = crypto.randomUUID().slice(0, 8);
  const db = getDb();
  const inbound = new Map<string, InboundEmail>();
  const sent: (OutgoingMessage & { id: string })[] = [];
  const domainName = `acme-${run}.test`;
  const address = `support@${domainName}`;
  const [owner] = await db.insert(user).values({ id: `u-${run}`, name: "Owner", email: `owner-${run}@x.test`, emailVerified: true }).returning();
  const [workspace] = await db.insert(workspaces).values({ name: `W ${run}` }).returning();
  await db.insert(members).values({ workspaceId: workspace!.id, userId: owner!.id, role: "owner" });
  const [connection] = await db.insert(connections).values({ workspaceId: workspace!.id, provider: "demo", status: "active" }).returning();
  const [domain] = await db.insert(domains).values({
    workspaceId: workspace!.id, connectionId: connection!.id, providerDomainId: domainName, name: domainName,
    enabled: true, status: "verified", sendingEnabled: true, receivingEnabled: true,
  }).returning();
  const [mailbox] = await db.insert(mailboxes).values({ workspaceId: workspace!.id, domainId: domain!.id, address, displayName: "Acme support" }).returning();
  await db.insert(mailboxMembers).values({ mailboxId: mailbox!.id, userId: owner!.id });

  const provider = {
    kind: "demo",
    capabilities: { backfill: false, refreshDomains: false },
    listDomains: async () => [],
    // Like SES, it writes its own Message-ID over ours.
    send: async (message: OutgoingMessage, id: string) => {
      sent.push({ ...message, id });
      return { id: `p-${id}`, messageIdHeader: `<${id}@mail.provider.test>` };
    },
    fetchInbound: async (id: string) => {
      const email = inbound.get(id);
      if (!email) throw new Error("No such email");
      return email;
    },
    listInbound: async () => ({ ids: [] }),
  } as MailProvider;

  const installAll = (more: Extensions = extensions) => install({
    ...more,
    mail: {
      providers: { demo: () => provider },
      ownMailbox: async ({ workspaceId }) => (workspaceId === workspace!.id ? { mailbox: mailbox! } : { mailbox: null }),
    },
  });
  installAll();

  let count = 0;
  return {
    run, owner: owner!, workspace: workspace!, connection: connection!, domain: domain!, mailbox: mailbox!, address, sent, installAll,
    /** Puts an email where the provider keeps it. Returns the id to ingest. */
    async receive(mail: Omit<TestMail, "to"> & { to?: string }) {
      const id = `${run}-${++count}`;
      inbound.set(id, await parseRawEmail(id, rawMail({ to: address, ...mail })));
      return id;
    },
  };
}

/** A support inbox on the workspace's mailbox, with a key. */
export async function testSupportInbox(w: Awaited<ReturnType<typeof testWorkspace>>) {
  const { supportInboxes, supportKeys } = await import("@hellobox/db");
  const { findSupportInbox, generateSupportKey } = await import("./support");
  const db = getDb();
  const [inbox] = await db.insert(supportInboxes).values({ workspaceId: w.workspace.id, mailboxId: w.mailbox.id, name: "App" }).returning();
  const { key, hash, prefix } = generateSupportKey();
  await db.insert(supportKeys).values({ workspaceId: w.workspace.id, inboxId: inbox!.id, name: "Server", keyHash: hash, prefix });
  return { id: inbox!.id, key, row: () => findSupportInbox(inbox!.id).then((row) => row!) };
}

/** What happens after a support message is stored, kept off the real queue. */
export function recordedAfter() {
  const notified: string[] = [];
  return { notified, notify: async (id: string) => notified.push(id), publish: async () => undefined };
}

/** Sends a reply the way the worker does, as if a person had pressed Send. */
export async function testReply(
  w: Awaited<ReturnType<typeof testWorkspace>>,
  input: { threadId: string | null; replyToMessageId: string | null; to: string[]; cc?: string[]; bcc?: string[]; html?: string; subject?: string },
) {
  const { messages, outbox } = await import("@hellobox/db");
  const { eq } = await import("drizzle-orm");
  const { sendOutbox } = await import("./send");
  const db = getDb();
  const [item] = await db.insert(outbox).values({
    workspaceId: w.workspace.id, userId: w.owner.id, mailboxId: w.mailbox.id, threadId: input.threadId, replyToMessageId: input.replyToMessageId,
    toRecipients: input.to, ccRecipients: input.cc ?? [], bccRecipients: input.bcc ?? [], subject: input.subject ?? "Re: Help", html: input.html ?? "<p>Hi</p>", sendAt: new Date(),
  }).returning();
  const result = await sendOutbox(item!.id);
  if (result.status !== "sent") throw new Error(result.status);
  const [sent] = await db.select().from(outbox).where(eq(outbox.id, item!.id));
  const [message] = await db.select().from(messages).where(eq(messages.id, sent!.messageId!));
  return { message: message!, headers: w.sent.at(-1)!.headers! };
}
