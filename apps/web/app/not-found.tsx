import type { Metadata } from "next";
import Link from "next/link";
import { StatusPage } from "@/components/status-page";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Page not found", robots: { index: false } };

export default function NotFound() {
  return (
    <StatusPage
      code="404"
      title="This page never arrived"
      description="The link may be old or mistyped. Your mail is still right where you left it."
      actions={
        <>
          <Button size="lg" render={<Link href="/inbox" />}>Go to your inbox</Button>
          <Button size="lg" variant="outline" render={<Link href="/" />}>Back to home</Button>
        </>
      }
    />
  );
}
