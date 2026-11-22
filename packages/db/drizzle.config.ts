import { setting } from "@hellobox/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  dbCredentials: { url: setting("DATABASE_URL") ?? "" },
});
