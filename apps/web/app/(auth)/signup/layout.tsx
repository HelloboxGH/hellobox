import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Create your account",
  description: "Create a free HelloBox account and get a real inbox for the domains you send from with Amazon SES, Resend, Postmark or Mailgun.",
  alternates: { canonical: "/signup" },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
