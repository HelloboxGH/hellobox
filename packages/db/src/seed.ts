// Fills a local database with a demo workspace to click around in.
//
//   bun run db:seed                 # for the first account in the database
//   bun run db:seed you@example.com # for that account
//
// The two teammates can sign in with email and password, to try the app as an admin
// (amara@northwind.test) or a member (leo@northwind.test). Both use DEMO_PASSWORD below.
//
// It makes "Northwind (demo)", owned by that account, with a pending Postmark connection
// (so the worker leaves it alone), two domains, shared and personal mailboxes, teammates,
// labels, contacts and about 45 conversations across every folder and category. Running
// it again replaces the demo workspace and leaves everything else alone.
import { randomBytes, scrypt } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createDemoWorkspace } from "./demo";
import * as schema from "./schema";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
if (!/@(localhost|127\.0\.0\.1|\[::1\]|postgres|db)(:\d+)?\//.test(url) && !process.argv.includes("--force")) {
  throw new Error("This isn't a local database. Pass --force if you really mean it");
}

const client = postgres(url, { max: 1 });
const db = drizzle(client, { schema });
const { user, account, workspaces, members } = schema;

const WORKSPACE = "Northwind (demo)";
const DEMO_PASSWORD = "northwind-demo";

// Better Auth's own format (@better-auth/utils/password): scrypt N=16384, r=16, p=1, 64
// bytes, with the hex salt used as text, stored as "salt:key".
function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return new Promise<string>((resolve, reject) =>
    scrypt(password.normalize("NFKC"), salt, 64, { N: 16384, r: 16, p: 1, maxmem: 128 * 16384 * 16 * 2 }, (error, key) =>
      error ? reject(error) : resolve(`${salt}:${key.toString("hex")}`),
    ),
  );
}

const email = process.argv.slice(2).find((arg) => arg.includes("@"));
const [me] = email
  ? await db.select().from(user).where(eq(user.email, email.toLowerCase()))
  : await db.select().from(user).orderBy(asc(user.createdAt)).limit(1);
if (!me) {
  throw new Error(email ? `No account for ${email}. Sign up in the app first` : "No accounts yet. Sign up in the app first");
}

// Start over: the demo workspace cascades to everything in it.
const old = await db
  .select({ id: workspaces.id })
  .from(workspaces)
  .innerJoin(members, eq(members.workspaceId, workspaces.id))
  .where(and(eq(workspaces.name, WORKSPACE), eq(members.userId, me.id), eq(members.role, "owner")));
if (old.length) await db.delete(workspaces).where(inArray(workspaces.id, old.map((row) => row.id)));

// Teammates who can't sign in, for assignments, notes and the team list.
const teammates = [
  { id: "demo-user-amara", name: "Amara Okafor", email: "amara@northwind.test" },
  { id: "demo-user-leo", name: "Léo Martin", email: "leo@northwind.test" },
];
await db
  .insert(user)
  .values(teammates.map((t) => ({ ...t, emailVerified: true, onboardedAt: new Date() })))
  .onConflictDoNothing();
await db.delete(account).where(
  and(inArray(account.userId, teammates.map((t) => t.id)), eq(account.providerId, "credential")),
);
await db.insert(account).values(
  await Promise.all(
    teammates.map(async (t) => ({
      id: `demo-account-${t.id}`,
      accountId: t.id,
      providerId: "credential",
      userId: t.id,
      password: await hashPassword(DEMO_PASSWORD),
    })),
  ),
);

const result = await createDemoWorkspace(db, {
  name: WORKSPACE,
  owner: me,
  teammateIds: [teammates[0]!.id, teammates[1]!.id],
  // A pending Postmark connection, so the worker leaves it alone.
  connection: { provider: "postmark", status: "pending" },
});

await client.end();
console.log(`Seeded "${WORKSPACE}" for ${me.email}: ${result.conversations} conversations, ${result.contacts} contacts, ${result.mailboxes.length} mailboxes.`);
console.log("Pick it from the workspace switcher in the sidebar.");
console.log(`Teammates sign in with password "${DEMO_PASSWORD}": ${teammates.map((t) => t.email).join(", ")}.`);
