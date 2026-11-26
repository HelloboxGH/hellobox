import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { connections, domains, mailboxes, mailboxMembers, members, supportConversations, supportInboxes, threads, user } from "@hellobox/db";
import { getExtensions, resetExtensions } from "@hellobox/extensions";
import { eq } from "drizzle-orm";
import { hasServices, memoryStorage, recordedAfter, testDb, testSupportInbox, testWorkspace } from "../../../../../packages/mail/src/testing";
import { runAsAgent } from "../agents/context";

// Who's asking, and in which workspace.
let signedIn = "";
let workspaceId = "";
memoryStorage();
// The open build's own: no hosted module is loaded, so what testWorkspace installs stays.
void mock.module("server-only", () => ({}));
void mock.module("@/core/extensions", () => ({ getExtensions }));
void mock.module("next/headers", () => ({
  headers: async () => new Headers({ "x-workspace-id": workspaceId }),
  cookies: async () => ({ get: () => undefined }),
}));
void mock.module("@/core/auth", () => ({
  getAuth: () => ({ api: { getSession: async () => (signedIn ? { user: { id: signedIn, name: "T", email: "t@x.test" }, session: { createdAt: new Date() } } : null) } }),
}));

const { supportActions } = await import("./support");
const { getThread, listThreads } = await import("./threads");
const { findSupportKey, postSupportMessage } = await import("@hellobox/mail");

type Action = (input?: unknown) => Promise<never>;
const act = <T = Record<string, unknown>>(path: keyof typeof supportActions, input?: unknown) =>
  (supportActions[path] as unknown as Action)(input) as Promise<T>;

describe.skipIf(!hasServices)("setting up support", () => {
  const db = testDb();
  let w: Awaited<ReturnType<typeof testWorkspace>>;
  let other: Awaited<ReturnType<typeof testWorkspace>>;
  let member: string;
  beforeAll(async () => {
    other = await testWorkspace();
    w = await testWorkspace();
    member = `m-${w.run}`;
    await db.insert(user).values({ id: member, name: "Member", email: `${member}@x.test`, emailVerified: true });
    await db.insert(members).values({ workspaceId: w.workspace.id, userId: member, role: "member" });
  });
  beforeEach(() => {
    w.installAll();
    signedIn = w.owner.id;
    workspaceId = w.workspace.id;
  });
  afterAll(resetExtensions);

  const setUp = async () => {
    const inbox = await act<{ id: string }>("/support/inboxes/create", { mailboxId: w.mailbox.id, name: "Acme app" });
    const { key } = await act<{ key: string }>("/support/keys/create", { inboxId: inbox.id, name: "Server" });
    return { id: inbox.id, key };
  };

  test("an admin gets a key that works until it's revoked, and is shown once", async () => {
    const { id, key } = await setUp();
    expect((await findSupportKey(key))?.inbox.id).toBe(id);
    const listed = await act<{ inboxes: { id: string; receiving: boolean; problem: string | null; keys: { id: string }[] }[] }>("/support/inboxes");
    const inbox = listed.inboxes.find((item) => item.id === id)!;
    expect(inbox).toMatchObject({ receiving: true, problem: null });
    expect(JSON.stringify(listed)).not.toContain(key);
    expect(JSON.stringify(listed)).not.toContain("keyHash");
    await act("/support/keys/revoke", { id: inbox.keys[0]!.id });
    expect(await findSupportKey(key)).toBeNull();
    await expect(act("/support/keys/revoke", { id: inbox.keys[0]!.id })).rejects.toThrow("not found");
  });

  test("the list says when a domain doesn't receive, or can't send", async () => {
    const { id } = await setUp();
    const find = async () =>
      (await act<{ inboxes: { id: string; receiving: boolean; problem: string | null }[] }>("/support/inboxes")).inboxes.find((item) => item.id === id)!;
    await db.update(domains).set({ receivingEnabled: false }).where(eq(domains.id, w.domain.id));
    expect(await find()).toMatchObject({ receiving: false, problem: null });
    await db.update(domains).set({ receivingEnabled: true }).where(eq(domains.id, w.domain.id));
    await db.update(connections).set({ status: "disconnected" }).where(eq(connections.id, w.connection.id));
    expect((await find()).problem).toBeString();
    await db.update(connections).set({ status: "active" }).where(eq(connections.id, w.connection.id));
  });

  test("members, agents and strangers can't", async () => {
    const { id } = await setUp();
    const listed = await act<{ inboxes: { id: string; keys: { id: string }[] }[] }>("/support/inboxes");
    const keyId = listed.inboxes.find((item) => item.id === id)!.keys[0]!.id;
    const attempts = () => [
      () => act("/support/inboxes"),
      () => act("/support/inboxes/create", { mailboxId: w.mailbox.id, name: "x" }),
      () => act("/support/inboxes/rename", { id, name: "x" }),
      () => act("/support/inboxes/delete", { id }),
      () => act("/support/keys/create", { inboxId: id, name: "x" }),
      () => act("/support/keys/revoke", { id: keyId }),
    ];
    signedIn = member;
    for (const attempt of attempts()) await expect(attempt()).rejects.toThrow("Only admins");
    signedIn = "";
    for (const attempt of attempts()) await expect(attempt()).rejects.toThrow("sign in");
    // Another workspace's admin, naming these ids in their own workspace.
    signedIn = other.owner.id;
    workspaceId = other.workspace.id;
    for (const attempt of attempts().slice(1)) await expect(attempt()).rejects.toThrow("not found");
    workspaceId = w.workspace.id;
    await expect(act("/support/inboxes")).rejects.toThrow("access");
    // The owner's own agent can read, and change nothing.
    const agent = { tokenId: "t", name: "Agent", userId: w.owner.id, workspaceId: w.workspace.id, scopes: ["read", "write", "send"] };
    for (const attempt of attempts().slice(1)) await expect(runAsAgent(agent, attempt)).rejects.toThrow("Agents can't");
    expect((await db.select().from(supportInboxes).where(eq(supportInboxes.id, id)))[0]).toMatchObject({ name: "Acme app" });
  });

  test("only a shared mailbox that can send takes messages", async () => {
    const [personal] = await db.insert(mailboxes).values({ workspaceId: w.workspace.id, domainId: w.domain.id, address: `me@${w.domain.name}`, personalUserId: w.owner.id }).returning();
    const { mailboxes: offered } = await act<{ mailboxes: { id: string }[] }>("/support/inboxes");
    expect(offered.map((item) => item.id)).toEqual([w.mailbox.id]);
    await expect(act("/support/inboxes/create", { mailboxId: personal!.id, name: "x" })).rejects.toThrow();
    await expect(act("/support/inboxes/create", { mailboxId: other.mailbox.id, name: "x" })).rejects.toThrow("not found");
  });

  test("a webhook takes public https addresses only, and its secret is shown once", async () => {
    const { id } = await setUp();
    process.env.NODE_ENV = "production";
    try {
      for (const url of ["http://app.example.com/h", "https://127.0.0.1/h", "https://10.0.0.1/h", "https://user:pw@app.example.com/h", "nope"]) {
        await expect(act("/support/webhook", { inboxId: id, url })).rejects.toThrow();
      }
      const first = await act<{ secret: string | null }>("/support/webhook", { inboxId: id, url: "https://app.example.com/h" });
      expect(first.secret).toStartWith("whsec_");
      // A new address keeps the secret.
      expect(await act("/support/webhook", { inboxId: id, url: "https://app.example.com/other" })).toEqual({ secret: null });
      const listed = await act<{ inboxes: { id: string; webhook: { url: string } | null }[] }>("/support/inboxes");
      expect(listed.inboxes.find((item) => item.id === id)!.webhook).toMatchObject({ url: "https://app.example.com/other" });
      expect(JSON.stringify(listed)).not.toContain(first.secret!);
      const rolled = await act<{ secret: string }>("/support/webhook/secret", { inboxId: id });
      expect(rolled.secret).not.toBe(first.secret);
      await act("/support/webhook", { inboxId: id, url: null });
      const [row] = await db.select().from(supportInboxes).where(eq(supportInboxes.id, id));
      expect(row).toMatchObject({ webhookUrl: null, webhookSecretEnc: null });
      signedIn = member;
      await expect(act("/support/webhook", { inboxId: id, url: "https://app.example.com/h" })).rejects.toThrow("Only admins");
    } finally {
      process.env.NODE_ENV = "test";
    }
  });

  describe("a conversation", () => {
    let count = 0;
    const start = async () => {
      const inbox = await testSupportInbox(w);
      const result = await postSupportMessage(
        await inbox.row(),
        { user: { id: `u${++count}`, email: `ada${count}@customer.test`, name: "Ada" }, text: "Help", idempotencyKey: "k", metadata: { plan: "pro" } },
        "api",
        recordedAfter(),
      );
      if (result.status !== "stored") throw new Error(result.status);
      const [row] = await db.select().from(supportConversations).where(eq(supportConversations.id, result.conversationId));
      return { inbox, threadId: row!.threadId, id: row!.id };
    };
    const state = async (threadId: string) => {
      const [row] = await db
        .select({ folder: threads.folder, status: supportConversations.status })
        .from(threads)
        .innerJoin(supportConversations, eq(supportConversations.threadId, threads.id))
        .where(eq(threads.id, threadId));
      return row;
    };
    const set = (threadIds: string[], status: string) => act<{ updated: number }>("/support/status", { threadIds, status });

    test("is archived when solved, and back when reopened", async () => {
      const { threadId } = await start();
      await set([threadId], "in_progress");
      expect(await state(threadId)).toEqual({ folder: "inbox", status: "in_progress" });
      expect(await set([threadId], "solved")).toEqual({ updated: 1 });
      expect(await set([threadId], "solved")).toEqual({ updated: 0 });
      expect(await state(threadId)).toEqual({ folder: "archive", status: "solved" });
      await set([threadId], "open");
      expect(await state(threadId)).toEqual({ folder: "inbox", status: "open" });
      // Someone archived it by hand: a status that isn't about solving leaves it there.
      await db.update(threads).set({ folder: "archive" }).where(eq(threads.id, threadId));
      await set([threadId], "in_progress");
      expect(await state(threadId)).toEqual({ folder: "archive", status: "in_progress" });
      await db.update(threads).set({ folder: "spam" }).where(eq(threads.id, threadId));
      await set([threadId], "solved");
      await set([threadId], "open");
      expect(await state(threadId)).toEqual({ folder: "spam", status: "open" });
    });

    test("is only for people who can read its mailbox", async () => {
      const { threadId } = await start();
      signedIn = member;
      await expect(set([threadId], "solved")).rejects.toThrow();
      await expect((getThread as unknown as Action)({ id: threadId })).rejects.toThrow();
      signedIn = other.owner.id;
      workspaceId = other.workspace.id;
      await expect(set([threadId], "solved")).rejects.toThrow();
      expect((await state(threadId))!.status).toBe("open");
      // With access, a member can.
      await db.insert(mailboxMembers).values({ mailboxId: w.mailbox.id, userId: member });
      signedIn = member;
      workspaceId = w.workspace.id;
      await set([threadId], "solved");
      expect((await state(threadId))!.status).toBe("solved");
      await db.delete(mailboxMembers).where(eq(mailboxMembers.userId, member));
    });

    test("shows the team who the customer is, and lists by status", async () => {
      const { threadId, id } = await start();
      const detail = (await (getThread as unknown as Action)({ id: threadId })) as { support: unknown; messages: { fromCustomer: boolean }[] };
      expect(detail.support).toMatchObject({ id, status: "open", verified: true, name: "Ada", metadata: { plan: "pro" } });
      expect(detail.messages.map((message) => message.fromCustomer)).toEqual([true]);
      const list = async (supportStatus?: string) =>
        ((await (listThreads as unknown as Action)({ view: "support", supportStatus })) as { threads: { id: string }[] }).threads.map((item) => item.id);
      expect(await list("open")).toContain(threadId);
      expect(await list("solved")).not.toContain(threadId);
      await set([threadId], "solved");
      expect(await list("open")).not.toContain(threadId);
      expect(await list("solved")).toContain(threadId);
      expect(await list()).toContain(threadId);
    });

    test("stays as mail when its support inbox is deleted", async () => {
      const { threadId, inbox } = await start();
      await act("/support/inboxes/delete", { id: inbox.id });
      expect(await findSupportKey(inbox.key)).toBeNull();
      expect(((await (getThread as unknown as Action)({ id: threadId })) as { support: unknown }).support).toBeNull();
      await expect(set([threadId], "solved")).rejects.toThrow("Only support");
    });
  });
});
