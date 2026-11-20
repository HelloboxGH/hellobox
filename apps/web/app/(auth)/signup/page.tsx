"use client";

import { EnvelopeOpen } from "@phosphor-icons/react";
import { GitHubIcon, GoogleIcon } from "@/components/brand-icons";
import Link from "next/link";
import { type FormEvent, useState } from "react";
import { PasswordInput } from "@/components/password-input";
import { ResendVerification } from "@/components/resend-verification";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { track } from "@/core/client/analytics";
import { authClient } from "@/core/client/auth-client";
import { clientExtensions } from "@/core/client/extensions";
import { useSearchParam } from "@/core/client/use-search-param";
import { useRedirectAction } from "@/core/client/use-redirect-action";

const { SignupFields } = clientExtensions;

export default function SignupPage() {
  const next = useSearchParam("next");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const redirect = useRedirectAction(setError);
  const leaving = redirect.pending !== null;

  function social(provider: "google" | "github") {
    setError(null);
    track("Signup submitted", { method: provider });
    void redirect.run(provider, () => authClient.signIn.social({ provider, callbackURL: next ?? "/inbox" }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email"));
    setBusy(true);
    setError(null);
    track("Signup submitted", { method: "email" });
    const { error: failure } = await authClient.signUp.email({
      // The name is asked for during onboarding.
      name: "",
      email,
      password: String(form.get("password")),
      callbackURL: next ?? "/inbox",
    });
    setBusy(false);
    if (failure) {
      setError(failure.message ?? "We couldn't create your account");
      track("Signup failed", { method: "email" });
    } else {
      setSentTo(email);
      track("Signup completed", { method: "email" });
    }
  }

  if (sentTo) {
    return (
      <Card>
        <CardPanel>
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon"><EnvelopeOpen /></EmptyMedia>
              <EmptyTitle>Check your email</EmptyTitle>
              <EmptyDescription>We sent a verification link to {sentTo}. Open it to start using HelloBox.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent className="w-full max-w-xs">
              {SignupFields && <SignupFields submitted />}
              <ResendVerification email={sentTo} startWithCooldown />
              <p className="text-muted-foreground text-xs">Can&apos;t find it? Check your spam folder.</p>
            </EmptyContent>
          </Empty>
        </CardPanel>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle render={<h1 />}>Create your account</CardTitle>
        <CardDescription>Free for one person, on up to 2 domains.</CardDescription>
      </CardHeader>
      <CardPanel className="space-y-4">
        <Form onSubmit={submit} className="space-y-4">
          <Field>
            <FieldLabel>Email</FieldLabel>
            <Input name="email" type="email" required autoComplete="email" placeholder="you@company.com" />
          </Field>
          <Field>
            <FieldLabel>Password</FieldLabel>
            <PasswordInput name="password" required minLength={10} autoComplete="new-password" />
            <FieldDescription>At least 10 characters.</FieldDescription>
          </Field>
          {SignupFields && <SignupFields />}
          {error && (
            <Alert variant="error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button type="submit" disabled={busy || leaving} className="w-full">
            {busy && <Spinner />} Create account
          </Button>
        </Form>
        <div className="flex items-center gap-3 text-muted-foreground text-xs">
          <Separator className="flex-1" /> or <Separator className="flex-1" />
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Button variant="outline" disabled={leaving || busy} onClick={() => social("google")}>
            {redirect.pending === "google" ? <Spinner /> : <GoogleIcon />} Google
          </Button>
          <Button variant="outline" disabled={leaving || busy} onClick={() => social("github")}>
            {redirect.pending === "github" ? <Spinner /> : <GitHubIcon />} GitHub
          </Button>
        </div>
        <p className="text-center text-muted-foreground text-sm">
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-foreground underline-offset-2 hover:underline">Sign in</Link>
        </p>
      </CardPanel>
    </Card>
  );
}
