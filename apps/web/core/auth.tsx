import { getExtensions } from "@/core/extensions";
import { suspendedMessage } from "@/core/server/support";
import { getEnv } from "@hellobox/config";
import {
  account,
  getDb,
  invitations,
  members,
  session,
  twoFactor as twoFactorTable,
  user,
  verification,
  workspaces,
} from "@hellobox/db";
import { destroyWorkspace, touchMemberWorkspaces } from "@hellobox/mail";
import { betterAuth } from "better-auth";
import {
  AccountDeleted,
  ResetPassword,
  SecurityNotice,
  securitySubject,
  sendAppEmail,
  VerifyEmail,
  Welcome,
} from "@hellobox/email";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";
import { generateRandomString } from "better-auth/crypto";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { twoFactor } from "better-auth/plugins";
import { mayCreateAccount, SIGNUPS_CLOSED_MESSAGE } from "@/core/signups";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import Redis from "ioredis";
import { removeStoredAvatar } from "@/core/server/avatar-store";

// A notice that fails to send must not undo what the person just did.
async function notify(input: Parameters<typeof sendAppEmail>[0]) {
  try {
    await sendAppEmail(input);
  } catch (error) {
    console.error(`[email] Couldn't send "${input.subject}":`, error);
  }
}

const welcome = (to: { email: string; name: string }) =>
  notify({
    to: to.email,
    subject: "Welcome to HelloBox",
    react: <Welcome name={to.name} />,
  });

// How long a fresh sign-in stands in for a password on sensitive changes.
export const REAUTH_WINDOW_MS = 10 * 60 * 1000;

// These take a password when the account has one. Without it, a recent sign-in is required.
const SENSITIVE_PATHS = new Set([
  "/two-factor/enable",
  "/two-factor/disable",
  "/two-factor/get-totp-uri",
  "/two-factor/generate-backup-codes",
  "/delete-user",
]);

export type HookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

async function requireRecentSignIn(ctx: HookContext) {
  const current = await getSessionFromCtx(ctx);
  if (!current) throw new APIError("UNAUTHORIZED", { message: "Please sign in" });
  if (Date.now() - new Date(current.session.createdAt).getTime() > REAUTH_WINDOW_MS) {
    throw new APIError("FORBIDDEN", {
      code: "REAUTH_REQUIRED",
      message: "Sign in again to confirm it's you",
    });
  }
}

// better-auth only asks for the code after a password sign-in. Provider sign-ins get the
// same treatment here: the new session is swapped for the pending two-factor cookie the
// plugin uses, and the code step on the login page completes the sign-in.
// The social providers' callback; the auth slot adds the others (SSO).
const PROVIDER_CALLBACK_PATHS = ["/callback/:id"];

const TWO_FACTOR_COOKIE_MAX_AGE = 600;

async function challengeTwoFactor(ctx: HookContext) {
  const created = ctx.context.newSession;
  if (!created?.user.twoFactorEnabled) return;
  deleteSessionCookie(ctx, true);
  await ctx.context.internalAdapter.deleteSession(created.session.token);
  ctx.context.setNewSession(null);
  const cookie = ctx.context.createAuthCookie("two_factor", { maxAge: TWO_FACTOR_COOKIE_MAX_AGE });
  const identifier = `2fa-${generateRandomString(20)}`;
  const expiresAt = new Date(Date.now() + TWO_FACTOR_COOKIE_MAX_AGE * 1000);
  await ctx.context.internalAdapter.createVerificationValue({ value: created.user.id, identifier, expiresAt });
  await ctx.context.internalAdapter.createVerificationValue({
    value: "0",
    identifier: `2fa-attempts-${identifier}`,
    expiresAt,
  });
  await ctx.setSignedCookie(cookie.name, identifier, ctx.context.secret, cookie.attributes);
  throw ctx.redirect(`${getEnv().APP_URL}/login?step=2fa`);
}

// ALLOW_SIGNUPS=false: new accounts only for admins and people with an invitation.
async function assertMayCreateAccount(email: string) {
  const allowed = await mayCreateAccount(email, async (address) => {
    const [open] = await getDb()
      .select({ id: invitations.id })
      .from(invitations)
      .where(and(sql`lower(${invitations.email}) = ${address}`, isNull(invitations.acceptedAt), gt(invitations.expiresAt, new Date())))
      .limit(1);
    return Boolean(open);
  });
  if (!allowed) throw new APIError("FORBIDDEN", { message: SIGNUPS_CLOSED_MESSAGE });
}

function create() {
  const env = getEnv();
  const providerCallbackPaths = new Set([...PROVIDER_CALLBACK_PATHS, ...(getExtensions().auth?.providerCallbackPaths ?? [])]);
  const redis = new Redis(env.REDIS_URL);
  const socialProviders = {
    ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ? {
          google: {
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          },
        }
      : {}),
    ...(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
      ? {
          github: {
            clientId: process.env.GITHUB_CLIENT_ID,
            clientSecret: process.env.GITHUB_CLIENT_SECRET,
          },
        }
      : {}),
  };

  return betterAuth({
    appName: "HelloBox",
    baseURL: env.APP_URL,
    secret: process.env.BETTER_AUTH_SECRET,
    // Development can run on any local port or either loopback name.
    trustedOrigins:
      env.NODE_ENV === "production"
        ? [env.APP_URL]
        : [env.APP_URL, "http://localhost:*", "http://127.0.0.1:*"],
    database: drizzleAdapter(getDb(), {
      provider: "pg",
      schema: {
        user,
        session,
        account,
        verification,
        twoFactor: twoFactorTable,
        ...getExtensions().auth?.schema,
      },
    }),
    secondaryStorage: {
      get: (key) => redis.get(key),
      set: async (key, value, ttl) => {
        if (ttl) await redis.set(key, value, "EX", ttl);
        else await redis.set(key, value);
      },
      delete: async (key) => {
        await redis.del(key);
      },
      getAndDelete: (key) => redis.getdel(key),
      increment: async (key, ttl) => {
        const value = await redis.incr(key);
        if (value === 1 && ttl) await redis.expire(key, ttl);
        return value;
      },
    },
    session: { storeSessionInDatabase: true },
    user: {
      // Set by cloud's anonymous plugin (the demo). The column stays in core, so the field is
      // declared here to type it on every session; cloud declares the same field.
      additionalFields: { isAnonymous: { type: "boolean", required: false, defaultValue: false, input: false } },
      deleteUser: {
        enabled: true,
        afterDelete: async (deleted) => {
          await removeStoredAvatar(deleted.image);
          await notify({
            to: deleted.email,
            subject: "Your HelloBox account is deleted",
            react: <AccountDeleted name={deleted.name} />,
          });
        },
        beforeDelete: async (deleted) => {
          const db = getDb();
          const owned = await db
            .select({ id: members.workspaceId })
            .from(members)
            .where(and(eq(members.userId, deleted.id), eq(members.role, "owner")));
          if (!owned.length) return;
          const others = await db
            .select({ userId: members.userId })
            .from(members)
            .where(inArray(members.workspaceId, owned.map((row) => row.id)));
          if (others.some((row) => row.userId !== deleted.id)) {
            throw new APIError("BAD_REQUEST", {
              message: "Remove your teammates or transfer the workspace first",
            });
          }
          const rows = await db
            .select()
            .from(workspaces)
            .where(inArray(workspaces.id, owned.map((row) => row.id)));
          const blocked = await getExtensions().billing?.beforeDeleteUser?.(rows.map((row) => row.id));
          if (blocked) throw new APIError("BAD_REQUEST", { message: blocked });
          await Promise.all(rows.map((row) => destroyWorkspace(row.id)));
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // Said out loud here: a refusal inside the user hook comes back as a fake success.
        if (ctx.path === "/sign-up/email" && typeof ctx.body?.email === "string") await assertMayCreateAccount(ctx.body.email);
        if (SENSITIVE_PATHS.has(ctx.path) && !ctx.body?.password) {
          await requireRecentSignIn(ctx);
          return;
        }
        // Cloud can refuse a password sign-in (a workspace that requires SSO).
        if (ctx.path !== "/sign-in/email") return;
        await getExtensions().auth?.beforeSignIn?.(ctx);
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (providerCallbackPaths.has(ctx.path)) {
          await challengeTwoFactor(ctx);
          return;
        }
        const change =
          ctx.path === "/change-password"
            ? "password_changed"
            : ctx.path === "/two-factor/disable"
              ? "two_factor_disabled"
              : null;
        const returned = ctx.context.returned;
        if (!change || !returned || returned instanceof APIError) return;
        // Changing the password replaces the session, so its response carries the user instead.
        const signedIn =
          (returned as { user?: { email: string; name: string } }).user ?? (await getSessionFromCtx(ctx))?.user;
        if (!signedIn) return;
        await notify({
          to: signedIn.email,
          subject: securitySubject(change),
          react: <SecurityNotice name={signedIn.name} change={change} at={new Date()} />,
        });
      }),
    },
    rateLimit: {
      enabled: true,
      storage: "secondary-storage",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 60, max: 5 },
        "/request-password-reset": { window: 60, max: 3 },
        "/send-verification-email": { window: 60, max: 3 },
        "/two-factor/*": { window: 60, max: 5 },
      },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user: to, url }) => {
        await sendAppEmail({
          to: to.email,
          subject: "Reset your HelloBox password",
          react: <ResetPassword name={to.name} url={url} />,
        });
      },
      onPasswordReset: async ({ user: to }) => {
        await notify({
          to: to.email,
          subject: securitySubject("password_changed"),
          react: <SecurityNotice name={to.name} change="password_changed" at={new Date()} />,
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user: to, url }) => {
        await sendAppEmail({
          to: to.email,
          subject: "Confirm your HelloBox email",
          react: <VerifyEmail name={to.name} url={url} />,
        });
      },
      // Email sign-ups are welcomed once they confirm their address.
      afterEmailVerification: async (verified) => {
        await welcome(verified);
      },
    },
    socialProviders,
    databaseHooks: {
      user: {
        create: {
          before: async (created) => {
            await assertMayCreateAccount(created.email);
          },
          // Every account starts with a personal workspace.
          after: async (created, ctx) => {
            // Cloud acts on the new account first (creator credit, where they heard about us)
            // and can say it needs no workspace (demo visitors get the sandbox instead).
            const cookieHeader = ctx?.headers?.get("cookie") ?? ctx?.request?.headers.get("cookie") ?? null;
            const handled = await getExtensions().auth?.onUserCreated?.(created, cookieHeader);
            if (handled?.skipWorkspace) return;
            const db = getDb();
            const [workspace] = await db
              .insert(workspaces)
              .values({ name: created.name.trim() ? `${created.name.trim()}'s workspace` : "My workspace" })
              .returning({ id: workspaces.id });
            if (!workspace) throw new Error("Could not create a workspace");
            await db.insert(members).values({
              workspaceId: workspace.id,
              userId: created.id,
              role: "owner",
            });
            // Google, GitHub and SSO accounts arrive already verified.
            if (created.emailVerified) await welcome(created);
          },
        },
      },
      session: {
        create: {
          // Banned accounts can't sign in, whichever way they try.
          before: async (created) => {
            const [row] = await getDb()
              .select({ bannedAt: user.bannedAt })
              .from(user)
              .where(eq(user.id, created.userId));
            if (row?.bannedAt) {
              throw new APIError("FORBIDDEN", { message: suspendedMessage("account") });
            }
          },
          // Signing in counts as activity in every workspace the person is in.
          after: async (created) => {
            await touchMemberWorkspaces(created.userId);
          },
        },
      },
    },
    plugins: [
      // People who sign in with Google, GitHub or SSO have no password to confirm with.
      // They sign in again instead, which requireRecentSignIn checks.
      twoFactor({ issuer: "HelloBox", allowPasswordless: true }),
      ...(getExtensions().auth?.plugins ?? []),
      nextCookies(),
    ],
  });
}

export type Auth = ReturnType<typeof create>;

let instance: Auth | undefined;

export function getAuth(): Auth {
  instance ??= create();
  return instance;
}
