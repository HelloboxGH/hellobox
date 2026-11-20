import { getEnv } from "@hellobox/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export * from "./schema";

function create() {
  return drizzle(postgres(getEnv().DATABASE_URL, { max: 10 }), { schema });
}

export type Db = ReturnType<typeof create>;

let instance: Db | undefined;

export function getDb(): Db {
  instance ??= create();
  return instance;
}
export { createDemoWorkspace, DEMO_DOMAIN, DEMO_TEAMMATES, type DemoWorkspaceInput } from "./demo";
