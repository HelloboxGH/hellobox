"use client";

import { CheckCircle, ShieldCheck, Terminal, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { ApiError, call } from "@/core/client/api";
import { authClient } from "@/core/client/auth-client";
import { notifyError } from "@/core/client/notify";
import { useSearchParam } from "@/core/client/use-search-param";

type Check = Awaited<ReturnType<typeof call<"/admin/cli/check">>>;

function useSignInRequest() {
  const port = Number(useSearchParam("port"));
  const state = useSearchParam("state");
  const challenge = useSearchParam("challenge");
  return port && state && challenge ? { port, state, challenge } : null;
}

const loginUrl = () =>
  `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;

async function signInAgain() {
  await authClient.signOut();
  window.location.href = loginUrl();
}

// The admin tool opens this page to ask for a sign-in. Approving sends a one-time
// code back to the tool's listener on this computer, and nowhere else.
export default function AdminCliPage() {
  const pending = useSignInRequest();
  const challenge = pending?.challenge;
  const [check, setCheck] = useState<Check | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!challenge) return;
    call("/admin/cli/check", { challenge })
      .then(setCheck)
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 401) {
          window.location.href = loginUrl();
          return;
        }
        setFailure(error instanceof Error ? error.message : "This sign-in link doesn't work");
      });
  }, [challenge]);

  if (failure || !pending) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Can&apos;t sign in the admin tool</CardTitle>
          <CardDescription>{failure ?? "Open this page by running hellobox-admin login in your terminal."}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (!check) {
    return (
      <p className="flex items-center justify-center gap-2 text-muted-foreground text-sm"><Spinner /> Checking your account…</p>
    );
  }

  if (!check.allowed) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Not an admin account</CardTitle>
          <CardDescription>{check.email} can&apos;t use the admin tool.</CardDescription>
        </CardHeader>
        <CardPanel>
          <Button variant="outline" className="w-full" onClick={signInAgain}>Use another account</Button>
        </CardPanel>
      </Card>
    );
  }

  if (done) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><CheckCircle className="text-success" /> You&apos;re signed in</CardTitle>
          <CardDescription>Go back to your terminal. You can close this tab.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Terminal /> Approve the admin tool</CardTitle>
        <CardDescription>hellobox-admin wants to sign in as {check.email}. It will be able to see usage and every account, and ban users and workspaces, for the next 12 hours.</CardDescription>
      </CardHeader>
      <CardPanel className="space-y-4">
        <div className="rounded-xl bg-muted p-4 text-center">
          <p className="text-muted-foreground text-xs">Check your terminal shows the same code</p>
          <p className="mt-1 font-mono font-semibold text-2xl text-foreground tracking-widest">{check.confirmation}</p>
        </div>
        {check.fresh ? (
          <Alert variant="info">
            <ShieldCheck />
            <AlertDescription>Only approve if you just ran hellobox-admin login on this computer.</AlertDescription>
          </Alert>
        ) : (
          <Alert variant="warning">
            <WarningCircle />
            <AlertDescription>For your security, sign in again before approving.</AlertDescription>
          </Alert>
        )}
        {check.fresh ? (
          <Button
            className="w-full"
            disabled={approving}
            onClick={async () => {
              setApproving(true);
              try {
                const { redirect } = await call("/admin/cli/approve", pending);
                setDone(true);
                window.location.href = redirect;
              } catch (error) {
                notifyError(error);
                setApproving(false);
              }
            }}
          >
            {approving && <Spinner />} Approve
          </Button>
        ) : (
          <Button className="w-full" onClick={signInAgain}>Sign in again</Button>
        )}
      </CardPanel>
    </Card>
  );
}
