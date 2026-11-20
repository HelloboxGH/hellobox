import type { MetadataRoute } from "next";
import { getExtensions } from "@/core/extensions";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return (await getExtensions().site?.sitemap?.()) ?? [];
}
