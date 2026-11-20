"use client";

import {
  compileBroadcast,
  compileBroadcastSubject,
  SAMPLE_CONTACT,
  type TemplateContact,
  TemplateError,
  templateVariables,
} from "@hellobox/mail/template";
import { ArrowCounterClockwise, PaperPlaneTilt, WarningCircle } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { Bootstrap } from "@/core/client/api";
import { call } from "@/core/client/api";
import { notify, notifyError } from "@/core/client/notify";
import { EmailPreview } from "./email-preview";
import { TemplateGuide } from "./template-guide";
import { TemplateValues } from "./template-values";
import { type SavedTemplate, STARTER_TEMPLATE } from "./templates-tab";

const SCRATCH = "scratch";

// Mailboxes on enabled domains that Resend can send from.
export const sendingMailboxes = (data: Bootstrap) =>
  data.mailboxes.filter((mailbox) => {
    const domain = data.domains.find((item) => item.id === mailbox.domainId);
    return domain?.enabled && domain.sendingEnabled;
  });

function variablesOf(...sources: string[]) {
  const names = new Set<string>();
  for (const source of sources) {
    try {
      for (const name of templateVariables(source).values) names.add(name);
    } catch {
      // The preview shows the syntax error.
    }
  }
  return [...names];
}

function campaignProblem(html: string, subject: string, values: Record<string, string>) {
  try {
    compileBroadcast(html, values);
    compileBroadcastSubject(subject, values);
    return null;
  } catch (error) {
    if (error instanceof TemplateError) return error.message;
    throw error;
  }
}

export function CampaignComposer({
  open, onOpenChange, data, templates, sampleContacts, subscribed, onSent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: Bootstrap;
  templates: SavedTemplate[];
  sampleContacts: TemplateContact[];
  subscribed: number;
  onSent: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-6xl">
        {open && (
          <ComposerForm
            data={data}
            templates={templates}
            sampleContacts={sampleContacts}
            subscribed={subscribed}
            onSent={() => { onOpenChange(false); onSent(); }}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}

function ComposerForm({
  data, templates, sampleContacts, subscribed, onSent,
}: {
  data: Bootstrap;
  templates: SavedTemplate[];
  sampleContacts: TemplateContact[];
  subscribed: number;
  onSent: () => void;
}) {
  const mailboxes = sendingMailboxes(data);
  const first = templates[0];
  const [name, setName] = useState("");
  const [mailboxId, setMailboxId] = useState(mailboxes[0]?.id ?? "");
  const [templateId, setTemplateId] = useState(first?.id ?? SCRATCH);
  const [subject, setSubject] = useState(first?.subject ?? "");
  const [html, setHtml] = useState(first?.html ?? STARTER_TEMPLATE);
  const [values, setValues] = useState<Record<string, string>>({});
  const [previewEmail, setPreviewEmail] = useState(sampleContacts[0]?.email ?? SAMPLE_CONTACT.email);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);

  const template = templates.find((item) => item.id === templateId) ?? null;
  const edited = template ? html !== template.html : false;
  const variables = useMemo(() => variablesOf(subject, html), [subject, html]);
  const filled = useMemo(
    () => Object.fromEntries(variables.map((variable) => [variable, values[variable] ?? ""])),
    [variables, values],
  );
  const problem = useMemo(() => campaignProblem(html, subject, filled), [html, subject, filled]);
  const previewContacts = sampleContacts.length ? sampleContacts : [SAMPLE_CONTACT];
  const previewContact = previewContacts.find((contact) => contact.email === previewEmail) ?? previewContacts[0] ?? SAMPLE_CONTACT;
  const mailbox = mailboxes.find((item) => item.id === mailboxId);
  const from = mailbox ? (mailbox.displayName ? `${mailbox.displayName} <${mailbox.address}>` : mailbox.address) : "";

  const pickTemplate = (id: string) => {
    setTemplateId(id);
    const next = templates.find((item) => item.id === id);
    setSubject(next?.subject ?? "");
    setHtml(next?.html ?? STARTER_TEMPLATE);
  };

  const send = async () => {
    setSending(true);
    try {
      await call("/campaigns/send", {
        name,
        mailboxId,
        templateId: template?.id ?? null,
        subject,
        html,
        values: filled,
      });
      notify("Campaign on its way", "Resend sends it to every subscribed contact.");
      onSent();
    } catch (error) {
      notifyError(error);
    } finally {
      setSending(false);
    }
  };

  const ready = Boolean(name.trim() && mailboxId && subject.trim() && html.trim() && !problem && subscribed > 0);

  return (
    <>
      <DialogHeader>
        <DialogTitle>New campaign</DialogTitle>
      </DialogHeader>
      <DialogPanel>
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="min-w-0 space-y-4">
            <Field>
              <FieldLabel>Name</FieldLabel>
              <Input autoFocus maxLength={120} value={name} onChange={(event) => setName(event.target.value)} placeholder="May newsletter" />
              <FieldDescription>Only you see this. It names the broadcast in Resend.</FieldDescription>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel>From</FieldLabel>
                <Select
                  value={mailboxId}
                  onValueChange={(value) => { if (value) setMailboxId(value); }}
                  items={mailboxes.map((item) => ({ label: item.address, value: item.id }))}
                >
                  <SelectTrigger aria-label="From"><SelectValue placeholder="No mailbox can send" /></SelectTrigger>
                  <SelectPopup>{mailboxes.map((item) => <SelectItem key={item.id} value={item.id}>{item.address}</SelectItem>)}</SelectPopup>
                </Select>
              </Field>
              <Field>
                <FieldLabel>Template</FieldLabel>
                <Select
                  value={templateId}
                  onValueChange={(value) => { if (value) pickTemplate(value); }}
                  items={[...templates.map((item) => ({ label: item.name, value: item.id })), { label: "Start from scratch", value: SCRATCH }]}
                >
                  <SelectTrigger aria-label="Template"><SelectValue /></SelectTrigger>
                  <SelectPopup>
                    {templates.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}
                    <SelectItem value={SCRATCH}>Start from scratch</SelectItem>
                  </SelectPopup>
                </Select>
              </Field>
            </div>
            <Field>
              <FieldLabel>Subject</FieldLabel>
              <Input maxLength={998} value={subject} onChange={(event) => setSubject(event.target.value)} />
            </Field>

            {variables.length > 0 && (
              <fieldset className="space-y-3 rounded-xl border p-4">
                <legend className="px-1 font-medium text-foreground text-sm">Values for this send</legend>
                <TemplateValues variables={variables} values={values} onChange={setValues} />
              </fieldset>
            )}

            <Field>
              <div className="flex w-full items-center justify-between gap-2">
                <FieldLabel>HTML</FieldLabel>
                {template && edited && (
                  <Button size="xs" variant="ghost" onClick={() => setHtml(template.html)}><ArrowCounterClockwise /> Back to the saved template</Button>
                )}
              </div>
              <Textarea spellCheck={false} className="min-h-64 font-mono text-xs [&_textarea]:max-h-[28rem] [&_textarea]:overflow-y-auto" value={html} onChange={(event) => setHtml(event.target.value)} />
              <FieldDescription>
                {template ? "Changes here apply to this campaign only. The saved template stays as it is." : "Write the email here, or save it as a template first to reuse it."}
              </FieldDescription>
            </Field>
            <TemplateGuide />
          </div>

          <div className="min-w-0 space-y-3 lg:sticky lg:top-0 lg:self-start">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-medium text-foreground text-sm">Preview</p>
              <Select
                value={previewContact.email}
                onValueChange={(value) => { if (value) setPreviewEmail(value); }}
                items={previewContacts.map((contact) => ({ label: contact.email, value: contact.email }))}
              >
                <SelectTrigger size="sm" className="w-56" aria-label="Preview as"><SelectValue /></SelectTrigger>
                <SelectPopup>{previewContacts.map((contact) => <SelectItem key={contact.email} value={contact.email}>{contact.email}</SelectItem>)}</SelectPopup>
              </Select>
            </div>
            {problem && (
              <Alert variant="error">
                <WarningCircle />
                <AlertDescription>{problem}</AlertDescription>
              </Alert>
            )}
            <EmailPreview source={html} subject={subject} contact={previewContact} values={filled} footerFrom={from || "you"} />
          </div>
        </div>
      </DialogPanel>
      <DialogFooter className="items-center">
        <p className="me-auto text-muted-foreground text-sm">
          {subscribed
            ? <>Goes to <span className="font-medium text-foreground tabular-nums">{subscribed.toLocaleString("en-US")}</span> subscribed {subscribed === 1 ? "contact" : "contacts"}</>
            : "Add contacts before sending"}
        </p>
        <Button disabled={!ready || sending} onClick={() => setConfirming(true)}><PaperPlaneTilt /> Send campaign</Button>
      </DialogFooter>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Send “{name}” now?</AlertDialogTitle>
            <AlertDialogDescription>
              It goes from {mailbox?.address} to {subscribed.toLocaleString("en-US")} subscribed {subscribed === 1 ? "contact" : "contacts"} through Resend. Once it&apos;s sent, it can&apos;t be called back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Not yet</AlertDialogClose>
            <AlertDialogClose render={<Button />} onClick={send}>Send campaign</AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
