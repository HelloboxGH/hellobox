import { getEnv, parseAdminEmails } from "@hellobox/config";
import { account, getDb, members, user } from "@hellobox/db";
import { getExtensions } from "@hellobox/extensions";
import { type DigestSignup, sendAppEmail, SignupDigest, signupDigestSubject } from "@hellobox/email";
import { and, count, eq, gte, inArray, lt } from "drizzle-orm";
import Redis from "ioredis";
import { createElement } from "react";

// The day boundary for the digest. Set ADMIN_DIGEST_TIMEZONE to an IANA zone such as Africa/Lome.
export const digestTimeZone = () => process.env.ADMIN_DIGEST_TIMEZONE || "UTC";

const METHODS: Record<string, string> = { credential: "Email", google: "Google", github: "GitHub" };
export const signupMethod = (providers: string[]) => {
  const names = [...new Set(providers.map((id) => METHODS[id] ?? "SSO"))];
  return names.length ? names.join(", ") : "Email";
};

let redis: Redis | undefined;
const LAST_RUN_KEY = "admin-digest:last-run";

// Signups since the last digest, so nobody is missed or counted twice when a run is late
// or retried. Days without signups send nothing.
export async function sendSignupDigest(now = new Date()) {
  const admins = parseAdminEmails();
  if (!admins.length) return { sent: 0 };
  redis ??= new Redis(getEnv().REDIS_URL);
  const last = await redis.get(LAST_RUN_KEY);
  const since = last ? new Date(last) : new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const db = getDb();
  const people = await db
    .select({ id: user.id, name: user.name, email: user.email, verified: user.emailVerified, createdAt: user.createdAt })
    .from(user)
    // Demo visitors aren't signups.
    .where(and(gte(user.createdAt, since), lt(user.createdAt, now), eq(user.isAnonymous, false)))
    .orderBy(user.createdAt);

  if (people.length) {
    const ids = people.map((person) => person.id);
    const [accounts, invited, [{ total }], sources] = await Promise.all([
      db.select({ userId: account.userId, providerId: account.providerId }).from(account).where(inArray(account.userId, ids)),
      invitedUserIds(ids),
      db.select({ total: count() }).from(user).where(eq(user.isAnonymous, false)),
      // How people heard about us: only a hosted build asks.
      getExtensions().admin?.signupSources?.(ids) ?? ({} as Record<string, string | null>),
    ]);
    const timeZone = digestTimeZone();
    const time = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit" });
    const day = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", month: "long", day: "numeric" }).format(now);
    const signups: DigestSignup[] = people.map((person) => ({
      // Signup doesn't ask for a name any more: it's set during onboarding.
      name: person.name || person.email,
      email: person.email,
      heardFrom: sources[person.id] ?? null,
      method: signupMethod(accounts.filter((row) => row.userId === person.id).map((row) => row.providerId)),
      verified: person.verified,
      joinedByInvite: invited.has(person.id),
      at: time.format(person.createdAt),
    }));
    const subject = signupDigestSubject(signups.length, day);
    for (const to of admins) {
      await sendAppEmail({ to, subject, react: createElement(SignupDigest, { day, signups, totalUsers: total }) });
    }
  }
  await redis.set(LAST_RUN_KEY, now.toISOString());
  return { sent: people.length ? admins.length : 0, signups: people.length };
}

// People whose first workspace was someone else's, meaning they came in through an invite.
async function invitedUserIds(ids: string[]) {
  const rows = await getDb().select({ userId: members.userId, role: members.role }).from(members).where(inArray(members.userId, ids));
  const owners = new Set(rows.filter((row) => row.role === "owner").map((row) => row.userId));
  return new Set(rows.filter((row) => !owners.has(row.userId)).map((row) => row.userId));
}
