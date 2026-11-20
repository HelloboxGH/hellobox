import { account, getDb, spamExemptions, user } from "@hellobox/db";
import { securitySubject, SecurityNotice, sendAppEmail } from "@hellobox/email";
import { normalizeExemptDomain } from "@hellobox/mail";
import { and, eq } from "drizzle-orm";
import { badRequest, forbidden, unauthorized } from "nezt";
import { headers } from "next/headers";
import { createElement } from "react";
import { z } from "zod";
import { getAuth, REAUTH_WINDOW_MS } from "@/core/auth";
import { userAction } from "../builder";

async function currentSession() {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) throw unauthorized("Please sign in");
  return session;
}

const signInMethods = async (userId: string) => {
  const rows = await getDb()
    .select({ providerId: account.providerId, password: account.password })
    .from(account)
    .where(eq(account.userId, userId));
  return {
    hasPassword: rows.some((row) => row.providerId === "credential" && Boolean(row.password)),
    providers: [...new Set(rows.filter((row) => row.providerId !== "credential").map((row) => row.providerId))],
  };
};

// What the security settings need: how this person signs in, and whether their sign-in is
// recent enough to stand in for a password.
export const securityStatus = userAction("/account/security").handler(async ({ ctx }) => {
  const session = await currentSession();
  const signedInAt = new Date(session.session.createdAt).getTime();
  return {
    ...(await signInMethods(ctx.user.id)),
    recentUntil: signedInAt + REAUTH_WINDOW_MS,
  };
});

// Accounts made with Google, GitHub or SSO have no password to change, so they add one
// after signing in again.
export const addPassword = userAction("/account/add-password")
  .input(z.object({ newPassword: z.string().min(10).max(128) }))
  .handler(async ({ input, ctx }) => {
    const session = await currentSession();
    if ((await signInMethods(ctx.user.id)).hasPassword) {
      throw badRequest("You already have a password. Change it instead");
    }
    if (Date.now() - new Date(session.session.createdAt).getTime() > REAUTH_WINDOW_MS) {
      throw forbidden("Sign in again to confirm it's you");
    }
    await getAuth().api.setPassword({ body: { newPassword: input.newPassword }, headers: await headers() });
    try {
      await sendAppEmail({
        to: ctx.user.email,
        subject: securitySubject("password_added"),
        react: createElement(SecurityNotice, { name: ctx.user.name, change: "password_added", at: new Date() }),
      });
    } catch (error) {
      console.error("[email] Couldn't send the password added notice:", error);
    }
    return { ok: true };
  });

export const setPreferences = userAction("/account/preferences")
  .input(z.object({ showWorkspaceUnread: z.boolean() }))
  .handler(async ({ input, ctx }) => {
    await getDb().update(user).set(input).where(eq(user.id, ctx.user.id));
    return { ok: true };
  });

// This person's never-spam domains. Mail from one doesn't land in Spam for any mailbox
// they read, unless the workspace blocked the sender.
export const listSpamExemptions = userAction("/account/spam-exemptions").handler(async ({ ctx }) => {
  const rows = await getDb()
    .select({ domain: spamExemptions.domain, createdAt: spamExemptions.createdAt })
    .from(spamExemptions)
    .where(eq(spamExemptions.userId, ctx.user.id))
    .orderBy(spamExemptions.domain);
  return { domains: rows };
});

export const addSpamExemption = userAction("/account/spam-exemptions/add")
  .input(z.object({ domain: z.string().trim().min(1).max(260) }))
  .handler(async ({ input, ctx }) => {
    const domain = normalizeExemptDomain(input.domain);
    if (!domain) throw badRequest("Enter a domain, like example.com");
    const db = getDb();
    const existing = await db.$count(spamExemptions, eq(spamExemptions.userId, ctx.user.id));
    if (existing >= 500) throw badRequest("You can keep up to 500 never-spam domains");
    await db.insert(spamExemptions).values({ userId: ctx.user.id, domain }).onConflictDoNothing();
    return { domain };
  });

export const removeSpamExemption = userAction("/account/spam-exemptions/remove")
  .input(z.object({ domain: z.string().trim().min(1).max(260) }))
  .handler(async ({ input, ctx }) => {
    await getDb()
      .delete(spamExemptions)
      .where(and(eq(spamExemptions.userId, ctx.user.id), eq(spamExemptions.domain, input.domain.toLowerCase())));
    return { ok: true };
  });

export const accountActions = {
  "/account/spam-exemptions": listSpamExemptions,
  "/account/spam-exemptions/add": addSpamExemption,
  "/account/spam-exemptions/remove": removeSpamExemption,
  "/account/preferences": setPreferences,
  "/account/security": securityStatus,
  "/account/add-password": addPassword,
};
