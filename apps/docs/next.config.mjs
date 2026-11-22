import { createMDX } from "fumadocs-mdx/next";

// A static site: `next build` writes plain files to out/, which any static host can serve.
/** @type {import('next').NextConfig} */
const config = {
  output: "export",
  reactStrictMode: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default createMDX()(config);
