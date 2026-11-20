"use client";

import { GitHubIcon, GoogleIcon } from "@/components/brand-icons";
import Link from "next/link";
import { type FormEvent, useRef, useState } from "react";
import { PasswordInput } from "@/components/password-input";
import { ResendVerification } from "@/components/resend-verification";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { OTPField, OTPFieldInput, OTPFieldSeparator } from "@/components/ui/otp-field";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/core/client/auth-client";
import { clientExtensions } from "@/core/client/extensions";
import { useSearchParam } from "@/core/client/use-search-param";
import { takeAfterSignIn } from "@/core/client/after-sign-in";
import { safeNext } from "@/core/safe-next";
import { useRedirectAction } from "@/core/client/use-redirect-action";

const SLOTS = ["a", "b", "c", "d", "e", "f"];
const { SignInMethods } = clientExtensions;

export default function LoginPage() {
  const step = useSearchParam("step");
  const linkExpired = useSearchParam("verify") === "expired";
  const next = safeNext(useSearchParam("next"));
  const [unverifiedEmail, setUnverifiedEmail] = useState<string | null>(null);
  const [needsCode, setNeedsCode] = useState(false);
  const twoFactor = needsCode || step === "2fa";
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [useBackup, setUseBackup] = useState(false);
  const [code, setCode] = useState("");
  const emailRef = useRef<HTMLInputElement>(null);
  const firstDigitRef = useRef<HTMLInputElement>(null);
  const redirect = useRedirectAction(setError);
  const leaving = redirect.pending !== null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    const result = twoFactor
      ? useBackup
        ? await authClient.twoFactor.verifyBackupCode({ code })
        : await authClient.twoFactor.verifyTotp({ code })
      : await authClient.signIn.email({
          email: String(form.get("email")),
          password: String(form.get("password")),
        });
    setBusy(false);
    if (result.error) {
      if (result.error.code === "EMAIL_NOT_VERIFIED") {
        setUnverifiedEmail(String(form.get("email")));
        setError(null);
        return;
      }
      setUnverifiedEmail(null);
      setError(result.error.message ?? "We couldn't sign you in");
      if (twoFactor && !useBackup) {
        setCode("");
        requestAnimationFrame(() => firstDigitRef.current?.focus());
      }
      return;
    }
    if (result.data && "twoFactorRedirect" in result.data && result.data.twoFactorRedirect) {
      setNeedsCode(true);
      return;
    }
    window.location.href = twoFactor ? takeAfterSignIn(next) : next;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle render={<h1 />}>{twoFactor ? "Enter your code" : "Welcome back"}</CardTitle>
        <CardDescription>
          {twoFactor
            ? useBackup
              ? "Use one of the backup codes you saved."
              : "Open your authenticator app for the 6-digit code."
            : "Sign in to your inbox."}
        </CardDescription>
      </CardHeader>
      <CardPanel className="space-y-4">
        <Form onSubmit={submit} className="space-y-4">
          {twoFactor ? (
            useBackup ? (
              <Field>
                <FieldLabel>Backup code</FieldLabel>
                <Input autoFocus required value={code} onChange={(e) => setCode(e.target.value)} />
              </Field>
            ) : (
              <Field>
                <FieldLabel className="sr-only">Verification code</FieldLabel>
                <OTPField length={6} value={code} onValueChange={setCode} autoSubmit size="lg" className="w-full">
                  {SLOTS.slice(0, 3).map((slot, index) => (
                    <OTPFieldInput key={slot} ref={index === 0 ? firstDigitRef : undefined} autoFocus={index === 0} aria-label={`Digit ${index + 1} of 6`} className="flex-1" />
                  ))}
                  <OTPFieldSeparator />
                  {SLOTS.slice(3).map((slot, index) => (
                    <OTPFieldInput key={slot} aria-label={`Digit ${index + 4} of 6`} className="flex-1" />
                  ))}
                </OTPField>
              </Field>
            )
          ) : (
            <>
              <Field>
                <FieldLabel>Email</FieldLabel>
                <Input ref={emailRef} name="email" type="email" required autoComplete="email" placeholder="you@company.com" />
              </Field>
              <Field>
                <div className="flex w-full items-center justify-between">
                  <FieldLabel>Password</FieldLabel>
                  <Link href="/forgot-password" className="text-muted-foreground text-xs underline-offset-2 hover:underline">
                    Forgot password?
                  </Link>
                </div>
                <PasswordInput name="password" required autoComplete="current-password" />
              </Field>
            </>
          )}
          {linkExpired && !unverifiedEmail && (
            <Alert variant="warning">
              <AlertDescription>That verification link has expired or was already used. Sign in below, and if your email isn&apos;t verified yet, we&apos;ll let you send a new link.</AlertDescription>
            </Alert>
          )}
          {unverifiedEmail && (
            <Alert variant="warning">
              <AlertDescription>Please verify {unverifiedEmail} before signing in. Open the link we emailed you, or send a new one.</AlertDescription>
            </Alert>
          )}
          {error && (
            <Alert variant="error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button type="submit" disabled={busy || leaving} className="w-full">
            {busy && <Spinner />}
            {twoFactor ? "Verify" : "Sign in"}
          </Button>
        </Form>
        {unverifiedEmail && <ResendVerification key={unverifiedEmail} email={unverifiedEmail} />}
        {twoFactor ? (
          <Button variant="ghost" className="w-full" onClick={() => { setUseBackup(!useBackup); setCode(""); }}>
            {useBackup ? "Use authenticator code" : "Use a backup code"}
          </Button>
        ) : (
          <>
            <div className="flex items-center gap-3 text-muted-foreground text-xs">
              <Separator className="flex-1" /> or <Separator className="flex-1" />
            </div>
            <div className={SignInMethods ? "grid gap-2 sm:grid-cols-3" : "grid gap-2 sm:grid-cols-2"}>
              <Button
                variant="outline"
                disabled={leaving || busy}
                onClick={() => { setError(null); void redirect.run("google", () => authClient.signIn.social({ provider: "google", callbackURL: next })); }}
              >
                {redirect.pending === "google" ? <Spinner /> : <GoogleIcon />} Google
              </Button>
              <Button
                variant="outline"
                disabled={leaving || busy}
                onClick={() => { setError(null); void redirect.run("github", () => authClient.signIn.social({ provider: "github", callbackURL: next })); }}
              >
                {redirect.pending === "github" ? <Spinner /> : <GitHubIcon />} GitHub
              </Button>
              {SignInMethods && (
                <SignInMethods
                  next={next}
                  disabled={leaving || busy}
                  pending={redirect.pending}
                  redirect={redirect.run}
                  email={() => emailRef.current?.value.trim() || null}
                  fail={(message, focusEmail) => {
                    setError(message);
                    if (focusEmail) emailRef.current?.focus();
                  }}
                />
              )}
            </div>
            <p className="text-center text-muted-foreground text-sm">
              New here?{" "}
              <Link href="/signup" className="font-medium text-foreground underline-offset-2 hover:underline">
                Create an account
              </Link>
            </p>
          </>
        )}
      </CardPanel>
    </Card>
  );
}
