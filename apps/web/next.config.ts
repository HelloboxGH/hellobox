import { existsSync } from "node:fs";
import type { NextConfig } from "next";

// Cloud code lives under cloud/ and is private. When it's missing (the open build), the
// @ext/* entry points fall back to the stubs in core/no-cloud/. tsc and Bun follow the
// tsconfig paths; Turbopack doesn't fall back, so it gets the answer here.
const hasCloud = existsSync(new URL("./cloud/server.ts", import.meta.url));
const entry = (cloud: string, open: string) => (hasCloud ? cloud : open);

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["bullmq", "ioredis", "postgres", "sanitize-html"],
  experimental: {
    agentFeedback: true,
  },
  cacheComponents: true,
  partialPrefetching: true,
  // Self-hosted has no landing page. The cloud build never redirects.
  async redirects() {
    return hasCloud ? [] : [{ source: "/", destination: "/inbox", permanent: false }];
  },
  // The share images live in public/cloud/. Their old URLs stay valid: pages and social
  // networks have them.
  async rewrites() {
    return hasCloud
      ? [
          { source: "/opengraph-image.png", destination: "/cloud/opengraph-image.png" },
          { source: "/twitter-image.png", destination: "/cloud/twitter-image.png" },
          { source: "/pricing/opengraph-image.png", destination: "/cloud/pricing-opengraph-image.png" },
          { source: "/pricing/twitter-image.png", destination: "/cloud/pricing-twitter-image.png" },
        ]
      : [];
  },
  turbopack: {
    resolveAlias: {
      "@ext/server": entry("./cloud/server.ts", "./core/no-cloud/server.ts"),
      "@ext/client": entry("./cloud/client.tsx", "./core/no-cloud/client.tsx"),
      "@ext/proxy": entry("./cloud/proxy.ts", "./core/no-cloud/proxy.ts"),
    },
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
