"use client";

import { type FormEvent, useState } from "react";
import { PasswordInput } from "@/components/password-input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { authClient } from "@/core/client/auth-client";
import { useSearchParam } from "@/core/client/use-search-param";

export default function ResetPasswordPage() {
  const token = useSearchParam("token");
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const { error: failure } = await authClient.resetPassword({
      newPassword: String(new FormData(event.currentTarget).get("password")),
      token: token ?? "",
    });
    if (failure) setError(failure.message ?? "This link has expired. Request a new one.");
    else window.location.href = "/login";
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Choose a new password</CardTitle>
      </CardHeader>
      <CardPanel>
        <Form onSubmit={submit} className="space-y-4">
          <Field>
            <FieldLabel>New password</FieldLabel>
            <PasswordInput name="password" required minLength={10} autoComplete="new-password" />
            <FieldDescription>At least 10 characters.</FieldDescription>
          </Field>
          {error && (
            <Alert variant="error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button type="submit" className="w-full">Save password</Button>
        </Form>
      </CardPanel>
    </Card>
  );
}
