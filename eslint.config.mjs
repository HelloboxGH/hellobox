// Lint for the worker and the packages. apps/web and apps/cloud-creators have their own
// configs (Next.js); all three share the rules in @hellobox/eslint-config.
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";
import { conventions } from "@hellobox/eslint-config";

export default defineConfig([
  globalIgnores(["**/node_modules/**", "**/dist/**", "**/migrations/**"]),
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: { parser: tseslint.parser },
    linterOptions: { reportUnusedDisableDirectives: "error" },
  },
  ...conventions({ ext: ["worker"] }),
]);
