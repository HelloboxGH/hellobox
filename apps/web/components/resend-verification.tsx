"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/core/client/auth-client";
import { notify, notifyError } from "@/core/client/notify";
import { useSearchParam } from "@/core/client/use-search-param";

const COOLDOWN_SECONDS = 60;

export function ResendVerification({
  email, startWithCooldown = false, variant = "outline",
}: {
  email: string;
  startWithCooldown?: boolean;
  variant?: "outline" | "default";
}) {
  const next = useSearchParam("next");
  const [busy, setBusy] = useState(false);
  const [remaining, setRemaining] = useState(startWithCooldown ? COOLDOWN_SECONDS : 0);

  useEffect(() => {
    if (remaining <= 0) return;
    const timer = setTimeout(() => setRemaining((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [remaining]);

  async function resend() {
    setBusy(true);
    const { error } = await authClient.sendVerificationEmail({ email, callbackURL: next ?? "/inbox" });
    setBusy(false);
    if (error) {
      notifyError(new Error(error.status === 429 ? "Too many requests. Please wait a minute and try again." : (error.message ?? "We couldn't send the email")));
      return;
    }
    notify("Verification email sent", `Check ${email}, including your spam folder.`);
    setRemaining(COOLDOWN_SECONDS);
  }

  return (
    <Button className="w-full" variant={variant} disabled={busy || remaining > 0} onClick={resend}>
      {busy && <Spinner />}
      {remaining > 0 ? `Resend email in ${remaining}s` : "Resend verification email"}
    </Button>
  );
}
