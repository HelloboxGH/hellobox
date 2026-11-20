"use client";

import type { TemplateContact } from "@hellobox/mail/template";
import { CodeBlock, DotsThree, PencilSimple, Plus, Trash } from "@phosphor-icons/react";
import { type FormEvent, useState } from "react";
import {
  AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { call } from "@/core/client/api";
import { notify, notifyError } from "@/core/client/notify";
import { EmailPreview } from "./email-preview";
import { TemplateGuide } from "./template-guide";

export type SavedTemplate = Awaited<ReturnType<typeof call<"/templates/list">>>[number];

export const STARTER_TEMPLATE = `<html>
  <body style="margin:0;background:#f5f5f5">
    <div style="max-width:560px;margin:0 auto;padding:32px 24px;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#26262b">
      <h1 style="font-size:22px;margin:0 0 16px">{{ headline }}</h1>
      <p>Hi {{ contact.first_name | default("there") }},</p>
      <p>{{ body }}</p>
      {% if button_url %}
      <p><a href="{{ button_url }}" style="display:inline-block;padding:10px 16px;border-radius:8px;background:#26262b;color:#ffffff;text-decoration:none">{{ button_label | default("Read more") }}</a></p>
      {% endif %}
    </div>
  </body>
</html>
`;

const SAMPLE_VALUES = { headline: "A headline", body: "Your message goes here.", button_url: "https://example.com" };

export function TemplatesTab({
  templates, sampleContact, onChanged,
}: {
  templates: SavedTemplate[] | null;
  sampleContact: TemplateContact | null;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState<SavedTemplate | "new" | null>(null);
  const [toDelete, setToDelete] = useState<SavedTemplate | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">Reusable HTML for campaigns and emails. Changing one never changes what was already sent.</p>
        <Button onClick={() => setEditing("new")}><Plus /> New template</Button>
      </div>

      {!templates ? (
        <div className="space-y-2">{[0, 1, 2].map((row) => <Skeleton key={row} className="h-14 w-full rounded-xl" />)}</div>
      ) : templates.length === 0 ? (
        <Empty className="rounded-2xl border bg-card">
          <EmptyHeader>
            <EmptyMedia variant="icon"><CodeBlock /></EmptyMedia>
            <EmptyTitle>No templates yet</EmptyTitle>
            <EmptyDescription>Write HTML once with placeholders like {"{{ contact.first_name }}"}, then reuse it for every campaign.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent><Button onClick={() => setEditing("new")}><Plus /> New template</Button></EmptyContent>
        </Empty>
      ) : (
        <ul className="divide-y overflow-hidden rounded-2xl border bg-card">
          {templates.map((template) => (
            <li key={template.id} className="flex items-center gap-3 px-4 py-3">
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setEditing(template)}>
                <p className="truncate font-medium text-foreground text-sm">{template.name}</p>
                <p className="truncate text-muted-foreground text-xs">{template.subject || "No subject"}</p>
              </button>
              <span className="text-muted-foreground text-xs tabular-nums max-sm:hidden">
                Edited {new Date(template.updatedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}
              </span>
              <Menu>
                <MenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label={`Actions for ${template.name}`} />}><DotsThree /></MenuTrigger>
                <MenuPopup align="end">
                  <MenuItem onClick={() => setEditing(template)}><PencilSimple /> Edit</MenuItem>
                  <MenuItem variant="destructive" onClick={() => setToDelete(template)}><Trash /> Delete</MenuItem>
                </MenuPopup>
              </Menu>
            </li>
          ))}
        </ul>
      )}

      <TemplateEditor
        template={editing}
        sampleContact={sampleContact}
        onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); onChanged(); }}
      />

      <AlertDialog open={toDelete !== null} onOpenChange={(open) => { if (!open) setToDelete(null); }}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {toDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>Campaigns already sent with it keep their own copy.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Keep template</AlertDialogClose>
            <AlertDialogClose
              render={<Button variant="destructive" />}
              onClick={async () => {
                if (!toDelete) return;
                try {
                  await call("/templates/delete", { id: toDelete.id });
                  onChanged();
                } catch (error) {
                  notifyError(error);
                }
              }}
            >
              Delete template
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

function TemplateEditor({
  template, sampleContact, onClose, onSaved,
}: {
  template: SavedTemplate | "new" | null;
  sampleContact: TemplateContact | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const existing = template && template !== "new" ? template : null;
  return (
    <Dialog open={template !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogPopup className="sm:max-w-6xl">
        {template !== null && (
          <TemplateForm key={existing?.id ?? "new"} existing={existing} sampleContact={sampleContact} onSaved={onSaved} />
        )}
      </DialogPopup>
    </Dialog>
  );
}

function TemplateForm({
  existing, sampleContact, onSaved,
}: {
  existing: SavedTemplate | null;
  sampleContact: TemplateContact | null;
  onSaved: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [subject, setSubject] = useState(existing?.subject ?? "{{ headline }}");
  const [html, setHtml] = useState(existing?.html ?? STARTER_TEMPLATE);
  const [saving, setSaving] = useState(false);

  return (
    <Form
      className="contents"
      onSubmit={async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setSaving(true);
        try {
          await call("/templates/save", { id: existing?.id, name, subject, html });
          notify(existing ? "Template saved" : "Template created");
          onSaved();
        } catch (error) {
          notifyError(error);
        } finally {
          setSaving(false);
        }
      }}
    >
      <DialogHeader>
        <DialogTitle>{existing ? "Edit template" : "New template"}</DialogTitle>
      </DialogHeader>
      <DialogPanel>
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="min-w-0 space-y-4">
            <Field>
              <FieldLabel>Name</FieldLabel>
              <Input required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} placeholder="Monthly update" autoFocus={!existing} />
            </Field>
            <Field>
              <FieldLabel>Subject</FieldLabel>
              <Input maxLength={998} value={subject} onChange={(event) => setSubject(event.target.value)} />
            </Field>
            <Field>
              <FieldLabel>HTML</FieldLabel>
              <Textarea
                required
                spellCheck={false}
                className="min-h-80 font-mono text-xs [&_textarea]:max-h-[28rem] [&_textarea]:overflow-y-auto"
                value={html}
                onChange={(event) => setHtml(event.target.value)}
              />
              <FieldDescription>Scripts and forms are removed when sending. An unsubscribe footer is added to every campaign.</FieldDescription>
            </Field>
            <TemplateGuide />
          </div>
          <div className="min-w-0 lg:sticky lg:top-0 lg:self-start">
            <p className="mb-2 font-medium text-foreground text-sm">Preview with {sampleContact ? sampleContact.email : "a sample contact"}</p>
            <EmailPreview source={html} subject={subject} contact={sampleContact} values={SAMPLE_VALUES} />
          </div>
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button type="submit" disabled={saving}>{existing ? "Save template" : "Create template"}</Button>
      </DialogFooter>
    </Form>
  );
}
