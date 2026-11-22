import { createFromSource } from "fumadocs-core/search/server";
import { source } from "@/lib/source";

// Built once at build time and served as a file; the browser searches it.
export const revalidate = false;
export const { staticGET: GET } = createFromSource(source, { language: "english" });
