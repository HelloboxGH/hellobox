// The lint rules behind docs/public/CONVENTIONS.md, shared by apps/web, apps/cloud-creators and
// the root config (the worker and every package). Each app's config spreads `conventions()`.

import { noHardCodedColors } from "./colors.mjs";

/** Hosted-only code: any `cloud`, `(cloud)` or `cloud-*` path segment. */
export const CLOUD_FILES = ["**/cloud/**", "**/(cloud)/**", "**/cloud-*/**"];

/**
 * Other companies' brand colors, allowed as hex classes: a provider's logo or button keeps
 * its brand color whatever our theme is.
 */
export const BRAND_COLORS = [
  "#F06B66", // Mailgun
  "#F38020", // Cloudflare
  "#E06D10", // Cloudflare, hover
];

const plugin = { rules: { "no-hard-coded-colors": noHardCodedColors } };

const cloudImports = {
  regex: "(^|/)(cloud|\\(cloud\\)|cloud-[^/]*)(/|$)",
  message: "Open code can't import cloud code. Add a slot in @hellobox/extensions.",
};
const extEntryPoints = (entries) => ({
  regex: `^@ext/(?!(${entries.join("|")})$)`,
  message: entries.length
    ? `Only ${entries.map((e) => `@ext/${e}`).join(", ")} can be imported here.`
    : "@ext entry points are for the apps.",
});
const bareBaseUi = {
  regex: "^@base-ui/",
  message: "Use the coss ui components in components/ui. Only they import Base UI directly.",
};
const otherIcons = ["lucide-react", "react-icons", "react-feather", "@radix-ui/react-icons"].map((name) => ({
  name,
  message: "Icons come from @phosphor-icons/react.",
}));
const otherIconPatterns = {
  regex: "^(react-icons|@heroicons|@tabler/icons|@fortawesome)(/|$)",
  message: "Icons come from @phosphor-icons/react.",
};

const envMessage =
  "Read settings through @hellobox/config: setting(\"NAME\"), isProduction() or isDevelopment(). Browser code may read process.env.NODE_ENV.";

/**
 * @param {object} [options]
 * @param {boolean} [options.ui] Interface rules: Base UI only in components/ui, theme colors, no dangerouslySetInnerHTML.
 * @param {string[]} [options.ext] The @ext entry points this code may import.
 * @param {string[]} [options.cloud] This app's hosted-only files, where the open-code rules don't apply.
 */
export function conventions({ ui = false, ext = [], cloud = CLOUD_FILES } = {}) {
  const files = ["**/*.{ts,tsx,mjs}"];
  return [
    // Open code only: what can be imported, and the interface rules.
    {
      files,
      ignores: cloud,
      plugins: { hellobox: plugin },
      rules: {
        "no-restricted-imports": [
          "error",
          {
            paths: otherIcons,
            patterns: [cloudImports, extEntryPoints(ext), otherIconPatterns, ...(ui ? [bareBaseUi] : [])],
          },
        ],
        ...(ui && {
          "react/no-danger": "error",
          "hellobox/no-hard-coded-colors": ["error", { allow: BRAND_COLORS }],
        }),
      },
    },
    // All code, hosted or not: settings come through @hellobox/config.
    {
      files,
      ignores: ["**/*.test.{ts,tsx}", "**/packages/config/**"],
      rules: {
        "no-restricted-syntax": [
          "error",
          {
            selector:
              "MemberExpression[object.name='process'][property.name='env']:not(MemberExpression[property.name='NODE_ENV'] > MemberExpression.object)",
            message: envMessage,
          },
          {
            selector: "MemberExpression[object.name='Bun'][property.name='env']",
            message: envMessage,
          },
        ],
      },
    },
  ];
}
