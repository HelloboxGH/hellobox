"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";
import { PasswordInput } from "@/components/password-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { call } from "@/core/client/api";
import { Section, useRun } from "../shared";

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  groq: "Groq",
  mistral: "Mistral",
  custom: "Custom (OpenAI-compatible)",
};
const providerLabel = (value: string) => PROVIDER_LABELS[value] ?? value;

export function AiTab() {
  const run = useRun();
  const [settings, setSettings] = useState<Awaited<ReturnType<typeof call<"/ai/settings">>> | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const load = useCallback(() => call("/ai/settings").then(setSettings), []);
  useEffect(() => {
    load();
  }, [load]);
  if (!settings) return <Skeleton className="h-64 w-full rounded-2xl" />;
  const providers = settings.providers.map((value) => ({ label: providerLabel(value), value }));
  const chosen = provider ?? settings.provider ?? providers[0]?.value ?? "";
  return (
    <Section title="Your AI provider" description="Bring your own key. It's encrypted, and the assistant only reads what you share. It writes drafts and can't send anything.">
      {settings.configured && (
        <div className="flex items-center gap-2">
          <Badge variant="success" className="me-auto">{providerLabel(settings.provider ?? "")} · {settings.model}</Badge>
          <Button size="sm" variant="destructive-outline" onClick={async () => { await run(() => call("/ai/remove"), "Removed"); load(); }}>Remove</Button>
        </div>
      )}
      <Form
        className="space-y-3"
        onSubmit={async (event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const target = event.currentTarget;
          const form = new FormData(target);
          const done = await run(
            () => call("/ai/save", { provider: chosen as "anthropic", model: String(form.get("model")), apiKey: String(form.get("apiKey")), baseUrl: chosen === "custom" ? String(form.get("baseUrl")) : undefined }),
            "Saved",
          );
          if (done) { target.reset(); load(); }
        }}
      >
        <Field>
          <FieldLabel>Provider</FieldLabel>
          <Select value={chosen} onValueChange={(value) => setProvider(value)} items={providers}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectPopup>{providers.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectPopup>
          </Select>
        </Field>
        {chosen === "custom" && (
          <Field>
            <FieldLabel>Base URL</FieldLabel>
            <Input key={settings.baseUrl} name="baseUrl" type="url" required placeholder="https://api.example.com/v1" defaultValue={settings.baseUrl ?? ""} />
            <FieldDescription>Any API that follows OpenAI&apos;s chat completions format. It has to be a public HTTPS address.</FieldDescription>
          </Field>
        )}
        <Field>
          <FieldLabel>Model</FieldLabel>
          <Input name="model" required />
          <FieldDescription>The exact model name from your provider.</FieldDescription>
        </Field>
        <Field><FieldLabel>API key</FieldLabel><PasswordInput name="apiKey" required autoComplete="off" /></Field>
        <Button type="submit">Save</Button>
      </Form>
    </Section>
  );
}
