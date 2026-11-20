import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Approve admin sign-in",
  robots: { index: false, follow: false },
};

export default function AdminCliLayout({ children }: { children: React.ReactNode }) {
  return children;
}
