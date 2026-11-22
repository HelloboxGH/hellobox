import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import { conventions } from "@hellobox/eslint-config";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "content/**", ".source/**"]),
  // The rules in docs/public/CONVENTIONS.md, shared with the other apps.
  ...conventions({ ui: true }),
]);
