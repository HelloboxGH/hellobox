import { domains, getDb, mailboxes, vaults, workspaces } from "@hellobox/db";
import { type SecurityChange, securitySubject, SecurityNotice, sendAppEmail } from "@hellobox/email";
import { and, eq, isNull } from "drizzle-orm";
import { badRequest, forbidden, notFound, unauthorized } from "nezt";
import { headers } from "next/headers";
import { createElement } from "react";
import { z } from "zod";
import { getAuth, REAUTH_WINDOW_MS } from "@/core/auth";
import { userAction } from "../builder";

// Mailbox encryption. Keys are made, wrapped and unwrapped on the person's device; the
// server only keeps the public key and the wrapped private key. See docs/plans/MAILBOX_ENCRYPTION.md.

const b64 = z.string().max(4096).regex(/^[A-Za-z0-9+/]+=*$/);
const wrappedKey = z.object({
  kdf: z.object({
    name: z.literal("argon2id"),
    // Lower bounds, so a buggy or hostile client can't store a key that's cheap to guess.
    m: z.number().int().min(19_456).max(1_048_576),
    t: z.number().int().min(2).max(10),
    p: z.number().int().min(1).max(4),
    salt: b64,
  }),
  iv: b64,
  data: b64,
});

async function requireRecentSignIn() {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) throw unauthorized("Please sign in");
  if (Date.now() - new Date(session.session.createdAt).getTime() > REAUTH_WINDOW_MS) {
    throw forbidden("Sign in again to confirm it's you");
  }
}

async function notice(user: { name: string; email: string }, change: SecurityChange) {
  try {
    await sendAppEmail({
      to: user.email,
      subject: securitySubject(change),
      react: createElement(SecurityNotice, { name: user.name, change, at: new Date() }),
    });
  } catch (error) {
    console.error("[email] Couldn't send the encryption notice:", error);
  }
}

export const vaultStatus = userAction("/account/vault").handler(async ({ ctx }) => {
  const db = getDb();
  const [vault] = await db.select().from(vaults).where(eq(vaults.userId, ctx.user.id));
  const personal = await db
    .select({
      id: mailboxes.id,
      address: mailboxes.address,
      encrypted: mailboxes.encrypted,
      workspace: workspaces.name,
    })
    .from(mailboxes)
    .innerJoin(workspaces, eq(workspaces.id, mailboxes.workspaceId))
    .leftJoin(domains, eq(domains.id, mailboxes.domainId))
    .where(and(eq(mailboxes.personalUserId, ctx.user.id), isNull(mailboxes.removedAt)))
    .orderBy(mailboxes.address);
  return {
    vault: vault
      ? {
          keyId: vault.keyId,
          publicKey: vault.publicKey,
          wrappedKey: vault.wrappedKey,
          recoveryWrappedKey: vault.recoveryWrappedKey,
          createdAt: vault.createdAt,
        }
      : null,
    mailboxes: personal,
  };
});

export const createVault = userAction("/account/vault/create")
  .input(z.object({ keyId: b64, publicKey: b64, wrappedKey, recoveryWrappedKey: wrappedKey }))
  .handler(async ({ input, ctx }) => {
    const [created] = await getDb()
      .insert(vaults)
      .values({ userId: ctx.user.id, ...input })
      .onConflictDoNothing()
      .returning({ keyId: vaults.keyId });
    if (!created) throw badRequest("You already have encryption keys");
    return { ok: true };
  });

// A new passphrase, wrapped on the device after unlocking with the old one or the recovery
// code. The key pair doesn't change, so stored mail still opens.
export const setVaultPassphrase = userAction("/account/vault/passphrase")
  .input(z.object({ keyId: b64, wrappedKey }))
  .handler(async ({ input, ctx }) => {
    await requireRecentSignIn();
    const [updated] = await getDb()
      .update(vaults)
      .set({ wrappedKey: input.wrappedKey, updatedAt: new Date() })
      .where(and(eq(vaults.userId, ctx.user.id), eq(vaults.keyId, input.keyId)))
      .returning({ keyId: vaults.keyId });
    if (!updated) throw notFound("Encryption key");
    await notice(ctx.user, "vault_passphrase_changed");
    return { ok: true };
  });

// Deleting the keys makes every message stored sealed unreadable for good. Mailboxes go
// back to storing mail in the clear.
export const deleteVault = userAction("/account/vault/delete")
  .input(z.object({ confirm: z.literal("DELETE MY KEYS") }))
  .handler(async ({ ctx }) => {
    await requireRecentSignIn();
    const db = getDb();
    await db.transaction(async (tx) => {
      await tx.update(mailboxes).set({ encrypted: false }).where(eq(mailboxes.personalUserId, ctx.user.id));
      await tx.delete(vaults).where(eq(vaults.userId, ctx.user.id));
    });
    await notice(ctx.user, "vault_deleted");
    return { ok: true };
  });

// Turning it on seals mail that arrives or is sent from now on. Turning it off stores new
// mail in the clear; what was sealed stays sealed and still opens with the key.
export const setMailboxEncrypted = userAction("/account/vault/mailbox")
  .input(z.object({ id: z.string(), encrypted: z.boolean() }))
  .handler(async ({ input, ctx }) => {
    const db = getDb();
    const [mailbox] = await db
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(and(eq(mailboxes.id, input.id), eq(mailboxes.personalUserId, ctx.user.id)));
    if (!mailbox) throw notFound("Personal mailbox");
    if (input.encrypted) {
      const [vault] = await db.select({ keyId: vaults.keyId }).from(vaults).where(eq(vaults.userId, ctx.user.id));
      if (!vault) throw badRequest("Set up encryption first");
    }
    await db.update(mailboxes).set({ encrypted: input.encrypted }).where(eq(mailboxes.id, mailbox.id));
    return { ok: true };
  });

export const vaultActions = {
  "/account/vault": vaultStatus,
  "/account/vault/create": createVault,
  "/account/vault/passphrase": setVaultPassphrase,
  "/account/vault/delete": deleteVault,
  "/account/vault/mailbox": setMailboxEncrypted,
};
