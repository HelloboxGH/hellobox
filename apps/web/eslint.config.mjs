import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

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
  {
    files: ["**/*.{ts,tsx,mjs}"],
    ignores: ["cloud/**", "app/(cloud)/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "(^|/)(cloud|\\(cloud\\)|cloud-[^/]*)(/|$)",
              message: "Open code can't import cloud code. Add a slot in @hellobox/extensions.",
            },
            {
              regex: "^@ext/(?!(server|client|proxy)$)",
              message: "Only @ext/server, @ext/client and @ext/proxy are entry points.",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
