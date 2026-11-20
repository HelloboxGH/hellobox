import type { Metadata } from "next";
import { TemplatesApp } from "@/components/campaigns/templates-app";

export const metadata: Metadata = { title: "Templates", robots: { index: false } };

export default function TemplatesPage() {
  return <TemplatesApp />;
}
