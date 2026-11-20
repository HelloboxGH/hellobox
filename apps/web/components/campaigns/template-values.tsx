"use client";

import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

const ACRONYMS: Record<string, string> = { url: "URL", cta: "CTA", id: "ID" };
// Hints for the names templates usually use; anything else gets no placeholder.
const HINTS: Record<string, string> = {
  headline: "A short, clear headline",
  title: "A short, clear title",
  preheader: "The line inboxes show after the subject",
  eyebrow: "A small label, like Product update",
  body: "Your message. Blank lines start new paragraphs.",
  message: "Your message. Blank lines start new paragraphs.",
  button_label: "What the button says",
  signoff: "Who it's from",
};

const MULTILINE = /(^|_)(body|message|content|text|description|intro|note|paragraph)s?($|_)/;

// "button_url" → "Button URL"
export const variableLabel = (name: string) =>
  name
    .split("_")
    .filter(Boolean)
    .map((word, index) => ACRONYMS[word] ?? (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ");

// The values a template asks for when you use it. Prose gets a growing textarea, links a
// URL field, everything else a single line. The template's own name stays visible, small.
export function TemplateValues({
  variables, values, onChange, autoFocus,
}: {
  variables: string[];
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
  autoFocus?: boolean;
}) {
  const set = (name: string, value: string) => onChange({ ...values, [name]: value });
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {variables.map((name, index) => {
        const multiline = MULTILINE.test(name);
        const url = name === "url" || name.endsWith("_url");
        return (
          <Field key={name} className={multiline ? "sm:col-span-2" : undefined}>
            <FieldLabel className="flex w-full items-baseline justify-between gap-2">
              {variableLabel(name)}
              <code className="font-mono font-normal text-[11px] text-muted-foreground">{`{{ ${name} }}`}</code>
            </FieldLabel>
            {multiline ? (
              <Textarea
                rows={4}
                autoFocus={autoFocus && index === 0}
                placeholder={HINTS[name]}
                value={values[name] ?? ""}
                onChange={(event) => set(name, event.target.value)}
                className="[&_textarea]:max-h-72 [&_textarea]:overflow-y-auto"
              />
            ) : (
              <Input
                type={url ? "url" : "text"}
                inputMode={url ? "url" : undefined}
                placeholder={url ? "https://" : HINTS[name]}
                autoFocus={autoFocus && index === 0}
                value={values[name] ?? ""}
                onChange={(event) => set(name, event.target.value)}
              />
            )}
          </Field>
        );
      })}
    </div>
  );
}
