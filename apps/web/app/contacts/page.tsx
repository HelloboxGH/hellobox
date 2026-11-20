import type { Metadata } from "next";
import { ContactsApp } from "@/components/campaigns/contacts-app";

export const metadata: Metadata = { title: "Contacts", robots: { index: false } };

export default function ContactsPage() {
  return <ContactsApp />;
}
