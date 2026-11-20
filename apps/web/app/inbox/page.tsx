import type { Metadata } from "next";
import { MailApp } from "@/components/mail/mail-app";

export const metadata: Metadata = { title: "Inbox", robots: { index: false } };

export default function InboxPage() {
  return <MailApp />;
}
