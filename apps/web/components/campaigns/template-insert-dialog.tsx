"use client";

import { BODY_VARIABLE, hasBodySlot, insertTemplate, renderSubject, type TemplateContact, templateVariables } from "@hellobox/mail/template";
import { CaretDown, Code, CodeBlock } from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldLabel } from "@/components/ui/field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { call } from "@/core/client/api";
import { notifyError } from "@/core/client/notify";
import { EmailPreview } from "./email-preview";
import { TemplateValues, variableLabel } from "./template-values";
import type { SavedTemplate } from "./templates-tab";

function variablesOf(...sources: string[]) {
  const names = new Set<string>();
  for (const source of sources) {
    try {
      // The email's own text fills {{ body }}, so there's nothing to type for it.
      for (const name of templateVariables(source).values) if (name !== BODY_VARIABLE) names.add(name);
    } catch {
      // The preview shows the syntax error.
    }
  }
  return [...names];
}

// Renders a saved template for one recipient around what the email already says, and
// hands the HTML to the composer, where it can still be edited before sending.
export function TemplateInsertDialog({
  open, onOpenChange, recipient, body, onInsert,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recipient: string | null;
  // The composer's HTML, or "" when nothing is written yet.
  body: string;
  onInsert: (result: { html: string; subject: string }) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-5xl">
        {open && <InsertForm recipient={recipient} body={body} onInsert={(result) => { onInsert(result); onOpenChange(false); }} />}
      </DialogPopup>
    </Dialog>
  );
}

function InsertForm({ recipient, body, onInsert }: { recipient: string | null; body: string; onInsert: (result: { html: string; subject: string }) => void }) {
  const [templates, setTemplates] = useState<SavedTemplate[] | null>(null);
  const [templateId, setTemplateId] = useState("");
  const [html, setHtml] = useState("");
  const [subject, setSubject] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [contact, setContact] = useState<{ data: TemplateContact; known: boolean } | null>(null);

  useEffect(() => {
    call("/templates/list")
      .then((list) => {
        setTemplates(list);
        const first = list[0];
        if (first) {
          setTemplateId(first.id);
          setHtml(first.html);
          setSubject(first.subject);
        }
      })
      .catch(notifyError);
  }, []);

  useEffect(() => {
    if (!recipient) return;
    call("/contacts/find", { email: recipient })
      .then((found) => setContact(
        found
          ? { data: { email: found.email, first_name: found.firstName, last_name: found.lastName, fields: found.fields }, known: true }
          : { data: { email: recipient }, known: false },
      ))
      .catch(() => setContact({ data: { email: recipient }, known: false }));
  }, [recipient]);

  const variables = useMemo(() => variablesOf(subject, html), [subject, html]);
  const filled = useMemo(
    () => Object.fromEntries(variables.map((variable) => [variable, values[variable] ?? ""])),
    [variables, values],
  );
  const target = contact?.data ?? { email: recipient ?? "" };
  const empty = variables.filter((variable) => !filled[variable]?.trim());

  if (!templates) return <DialogPanel><Skeleton className="h-64 w-full rounded-xl" /></DialogPanel>;
  if (!templates.length) {
    return (
      <DialogPanel>
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><CodeBlock /></EmptyMedia>
            <EmptyTitle>No templates yet</EmptyTitle>
            <EmptyDescription>Save HTML with placeholders once, then fill it in for any email or campaign.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent><Button render={<Link href="/templates" />}>Create a template</Button></EmptyContent>
        </Empty>
      </DialogPanel>
    );
  }

  const insert = () => {
    try {
      onInsert({
        html: insertTemplate(html, { contact: target, values: filled, unsubscribeUrl: "", body }),
        subject: renderSubject(subject, { contact: target, values: filled }),
      });
    } catch (error) {
      notifyError(error);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Use a template</DialogTitle>
        <DialogDescription>
          {recipient
            ? contact?.known === false
              ? `For ${recipient}. They aren't a contact yet, so only their email is filled in.`
              : `For ${recipient}. Their name and fields come from your contacts.`
            : "Add a recipient first, and their name and fields fill in from your contacts."}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="min-w-0 space-y-4">
            <Field>
              <FieldLabel>Template</FieldLabel>
              <Select
                value={templateId}
                onValueChange={(value) => {
                  const next = templates.find((item) => item.id === value);
                  if (!next) return;
                  setTemplateId(next.id);
                  setHtml(next.html);
                  setSubject(next.subject);
                }}
                items={templates.map((item) => ({ label: item.name, value: item.id }))}
              >
                <SelectTrigger aria-label="Template"><SelectValue /></SelectTrigger>
                <SelectPopup>
                  {templates.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      <span className="grid">
                        <span>{item.name}</span>
                        {item.subject && <span className="truncate font-mono text-muted-foreground text-xs">{item.subject}</span>}
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
            {variables.length > 0 ? (
              <section className="space-y-3 border-t pt-4">
                <h3 className="font-medium text-foreground text-sm">Fill it in</h3>
                <TemplateValues key={templateId} variables={variables} values={values} onChange={setValues} autoFocus />
              </section>
            ) : (
              <p className="border-t pt-4 text-muted-foreground text-sm">This template has nothing to fill in. It&apos;s ready to insert.</p>
            )}
            <Collapsible className="border-t pt-3">
              <CollapsibleTrigger className="group flex w-full cursor-pointer items-center justify-between gap-2 rounded-md py-1 font-medium text-muted-foreground text-sm hover:text-foreground">
                <span className="flex items-center gap-2"><Code /> Edit the HTML for this email</span>
                <CaretDown className="transition-transform group-data-panel-open:rotate-180" />
              </CollapsibleTrigger>
              <CollapsiblePanel>
                <div className="pt-3">
                  <Textarea spellCheck={false} aria-label="HTML" className="min-h-48 font-mono text-xs [&_textarea]:max-h-[24rem] [&_textarea]:overflow-y-auto" value={html} onChange={(event) => setHtml(event.target.value)} />
                  <p className="mt-2 text-muted-foreground text-xs">Changes apply to this email only. The saved template stays as it is.</p>
                </div>
              </CollapsiblePanel>
            </Collapsible>
          </div>
          <div className="min-w-0 lg:sticky lg:top-0 lg:self-start">
            <EmailPreview source={html} subject={subject} contact={target} values={filled} body={body} />
          </div>
        </div>
      </DialogPanel>
      <DialogFooter>
        <p className="me-auto hidden self-center text-muted-foreground text-xs sm:block">
          {empty.length
            ? `${empty.map(variableLabel).join(", ")} ${empty.length === 1 ? "is" : "are"} empty and will be left out.`
            : body
              ? hasBodySlot(html)
                ? "What you've written goes where the template says {{ body }}."
                : "What you've written goes below the template."
              : "You can still edit everything in the composer."}
        </p>
        <Button onClick={insert}>Insert into email</Button>
      </DialogFooter>
    </>
  );
}
