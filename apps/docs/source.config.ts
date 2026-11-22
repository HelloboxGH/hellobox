import { defineConfig, defineDocs } from "fumadocs-mdx/config";

// content/ is made by scripts/content.ts from docs/ and CONTRIBUTING.md.
export const docs = defineDocs({
  dir: "content",
});

export default defineConfig({
  mdxOptions: {
    // Code blocks in a language the highlighter doesn't know (Caddyfiles) show as plain text.
    rehypeCodeOptions: { fallbackLanguage: "plaintext" },
  },
});
