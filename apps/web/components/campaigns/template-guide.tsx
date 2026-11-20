"use client";

import { BookOpenText, CaretDown } from "@phosphor-icons/react";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";

const ROWS: { code: string; what: string }[] = [
  { code: "{{ contact.first_name }}", what: "A contact field: email, first_name, last_name, or any custom field, such as contact.company." },
  { code: '{{ contact.first_name | default("there") }}', what: "Prints the fallback when the field is empty." },
  { code: "{{ headline }}", what: "A value you fill in each time you send." },
  { code: "{{ headline | upper }}", what: "Filters: default, upper, lower, capitalize and trim." },
  { code: "{{ intro | safe }}", what: "Prints a value as HTML. Everything else is escaped, so it shows as text." },
  { code: '{% if plan == "pro" %}…{% elif promo %}…{% else %}…{% endif %}', what: "Shows a part only when a condition holds. Use ==, !=, and, or, not and brackets." },
  { code: "{{ unsubscribe_url }}", what: "The recipient's unsubscribe link, to place it yourself. A footer with one is added to every campaign anyway." },
  { code: "{# note #}", what: "A comment. It never reaches the email." },
  { code: "{% raw %}{{ … }}{% endraw %}", what: "Prints the braces as they are." },
];

export function TemplateGuide({ defaultOpen = false }: { defaultOpen?: boolean }) {
  return (
    <Collapsible defaultOpen={defaultOpen} className="rounded-xl border bg-muted/40">
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left font-medium text-foreground text-sm [&[data-panel-open]>svg:last-child]:rotate-180">
        <BookOpenText className="size-4 text-muted-foreground" />
        <span className="flex-1">Template syntax</span>
        <CaretDown className="size-4 text-muted-foreground transition-transform" />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="space-y-3 px-3 pb-3 text-sm">
          <dl className="space-y-2">
            {ROWS.map((row) => (
              <div key={row.code} className="grid gap-0.5 sm:grid-cols-[minmax(0,18rem)_1fr] sm:gap-3">
                <dt><code className="break-all font-mono text-foreground text-xs">{row.code}</code></dt>
                <dd className="text-muted-foreground text-xs">{row.what}</dd>
              </div>
            ))}
          </dl>
          <p className="text-muted-foreground text-xs">
            In a campaign, contact fields are filled in for each recipient by your provider, so they can be printed with a fallback
            but can&apos;t be used in conditions or other filters, and the subject can only use your own values.
            One-to-one emails and previews can use them anywhere.
          </p>
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
