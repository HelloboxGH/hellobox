import type { Metadata } from "next";
import { CampaignsApp } from "@/components/campaigns/campaigns-app";

export const metadata: Metadata = { title: "Campaigns", robots: { index: false } };

export default function CampaignsPage() {
  return <CampaignsApp />;
}
