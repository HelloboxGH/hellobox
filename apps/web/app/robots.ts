import type { MetadataRoute } from "next";
import { getExtensions } from "@/core/extensions";

// A self-hosted instance is a private app with nothing to index. A marketing site (cloud)
// says otherwise.
export default function robots(): MetadataRoute.Robots {
  return getExtensions().site?.robots?.() ?? { rules: { userAgent: "*", disallow: "/" } };
}
