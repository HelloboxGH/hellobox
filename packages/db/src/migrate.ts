import { setting } from "@hellobox/config";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = setting("DATABASE_URL");
if (!url) throw new Error("DATABASE_URL is required");

// Drizzle reads the last applied migration before it opens its transaction, so two workers
// starting together would both try to apply the same ones. A Postgres advisory lock makes
// the second wait, and then find nothing left to do. The connection is the only one
// (max: 1), so the lock and the migrations share a session, and the lock goes away with it.
const MIGRATION_LOCK = 7_283_650_010;

const client = postgres(url, { max: 1 });
try {
  await client`select pg_advisory_lock(${MIGRATION_LOCK}::bigint)`;
  await migrate(drizzle(client), {
    migrationsFolder: new URL("../migrations", import.meta.url).pathname,
  });
  await client`select pg_advisory_unlock(${MIGRATION_LOCK}::bigint)`;
} finally {
  await client.end();
}
console.log("Migrations applied");
