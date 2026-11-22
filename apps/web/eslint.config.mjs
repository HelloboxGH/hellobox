import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import { conventions } from "@hellobox/eslint-config";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored from coss ui.
    "components/ui/**",
    "hooks/**",
    "lib/composer-*.ts",
  ]),
  // The rules in docs/public/CONVENTIONS.md, shared with the worker and packages.
  ...conventions({ ui: true, ext: ["server", "client", "proxy"], cloud: ["cloud/**", "app/(cloud)/**"] }),
]);

export default eslintConfig;
