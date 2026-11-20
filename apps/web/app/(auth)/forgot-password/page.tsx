"use client";

import { EnvelopeOpen } from "@phosphor-icons/react";
import Link from "next/link";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/core/client/auth-client";

export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    await authClient.requestPasswordReset({
      email: String(new FormData(event.currentTarget).get("email")),
      redirectTo: "/reset-password",
    });
    setBusy(false);
    // Same message either way, so this can't reveal who has an account.
    setSent(true);
  }

  return (
    <Card>
      {sent ? (
        <CardPanel>
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon"><EnvelopeOpen /></EmptyMedia>
              <EmptyTitle>Check your email</EmptyTitle>
              <EmptyDescription>If that address has an account, a reset link is on its way.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </CardPanel>
      ) : (
        <>
          <CardHeader>
            <CardTitle>Reset your password</CardTitle>
            <CardDescription>We&apos;ll email you a link to choose a new one.</CardDescription>
          </CardHeader>
          <CardPanel className="space-y-4">
            <Form onSubmit={submit} className="space-y-4">
              <Field>
                <FieldLabel>Email</FieldLabel>
                <Input name="email" type="email" required autoComplete="email" />
              </Field>
              <Button type="submit" disabled={busy} className="w-full">
                {busy && <Spinner />} Send reset link
              </Button>
            </Form>
            <p className="text-center text-sm">
              <Link href="/login" className="text-muted-foreground underline-offset-2 hover:underline">Back to sign in</Link>
            </p>
          </CardPanel>
        </>
      )}
    </Card>
  );
}
