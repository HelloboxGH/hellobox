"use client";

import { useEffect } from "react";
import { StatusPage } from "@/components/status-page";
import { Button } from "@/components/ui/button";
import { clientExtensions } from "@/core/client/extensions";
import { ISSUES_URL } from "@/core/links";

export function ErrorContent({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const digest = (error as { digest?: string } | null)?.digest;
  return (
    <StatusPage
      code="500"
      title="Something went wrong on our side"
      description="Your mail is safe. Try again, and if this keeps happening, please contact us."
      actions={
        <>
          <Button size="lg" onClick={() => retry()}>Try again</Button>
          <Button size="lg" variant="outline" render={<a href={clientExtensions.supportEmail ? `mailto:${clientExtensions.supportEmail}` : ISSUES_URL} />}>
            Contact us
          </Button>
        </>
      }
      footnote={digest ? <>Error reference: <code className="font-mono">{digest}</code></> : undefined}
    />
  );
}
