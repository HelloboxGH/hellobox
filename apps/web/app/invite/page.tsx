"use client";

import { useEffect, useState } from "react";
import { Logo } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ApiError, call, setWorkspaceId } from "@/core/client/api";

export default function InvitePage() {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token") ?? "";
    call("/members/accept-invite", { token })
      .then(({ workspaceId }) => {
        setWorkspaceId(workspaceId);
        window.location.href = "/inbox";
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 401) {
          const next = encodeURIComponent(window.location.pathname + window.location.search);
          window.location.href = `/signup?next=${next}`;
          return;
        }
        setMessage(error instanceof Error ? error.message : "This invitation can't be used");
      });
  }, []);

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-canvas p-4 text-center">
      <Logo size={48} />
      {message ? (
        <>
          <p className="text-muted-foreground text-sm">{message}</p>
          <Button variant="outline" onClick={() => { window.location.href = "/inbox"; }}>Go to inbox</Button>
        </>
      ) : (
        <p className="flex items-center gap-2 text-muted-foreground text-sm"><Spinner /> Joining the workspace…</p>
      )}
    </main>
  );
}
