import type { Metadata } from "next";
import { SettingsApp } from "@/components/settings/settings-app";

export const metadata: Metadata = { title: "Settings", robots: { index: false } };

export default function SettingsPage() {
  return <SettingsApp />;
}
