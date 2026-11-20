"use client";

import {
  addUnsubscribeFooter,
  insertTemplate,
  renderSubject,
  renderTemplate,
  SAMPLE_CONTACT,
  type TemplateContact,
  TemplateError,
} from "@hellobox/mail/template";
import { WarningCircle } from "@phosphor-icons/react";
import { useDeferredValue, useMemo } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";

export const PREVIEW_UNSUBSCRIBE_URL = "https://hellobox.app/unsubscribe/preview";

// Fully sandboxed: no scripts, no same-origin access, and only remote images load.
const previewDocument = (html: string) =>
  `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; font-src https: data:"><base target="_blank"><style>body{margin:0;padding:16px;font:14px/1.6 system-ui,sans-serif;color:#26262b;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style></head><body>${html}</body></html>`;

export function renderPreview(source: string, subject: string, data: { contact: TemplateContact; values: Record<string, string>; body?: string }, footerFrom?: string) {
  try {
    const filled = { ...data, unsubscribeUrl: PREVIEW_UNSUBSCRIBE_URL };
    const body = data.body === undefined ? renderTemplate(source, filled) : insertTemplate(source, { ...filled, body: data.body });
    return {
      html: footerFrom ? addUnsubscribeFooter(body, PREVIEW_UNSUBSCRIBE_URL, footerFrom) : body,
      subject: renderSubject(subject, data),
      error: null,
    };
  } catch (error) {
    if (error instanceof TemplateError) return { html: "", subject: "", error: error.message };
    throw error;
  }
}

export function EmailPreview({
  source,
  subject,
  contact,
  values = {},
  body,
  footerFrom,
  className,
}: {
  source: string;
  subject: string;
  contact?: TemplateContact | null;
  values?: Record<string, string>;
  // What the email already says, shown where the template puts it.
  body?: string;
  // Campaigns always get an unsubscribe footer, so their preview shows it.
  footerFrom?: string;
  className?: string;
}) {
  const deferredSource = useDeferredValue(source);
  const deferredSubject = useDeferredValue(subject);
  const preview = useMemo(
    () => renderPreview(deferredSource, deferredSubject, { contact: contact ?? SAMPLE_CONTACT, values, body }, footerFrom),
    [deferredSource, deferredSubject, contact, values, body, footerFrom],
  );
  if (preview.error) {
    return (
      <Alert variant="error">
        <WarningCircle />
        <AlertDescription>{preview.error}</AlertDescription>
      </Alert>
    );
  }
  return (
    <div className={className}>
      <p className="mb-2 truncate text-sm">
        <span className="text-muted-foreground">Subject </span>
        <span className="font-medium text-foreground">{preview.subject || "No subject"}</span>
      </p>
      <iframe
        title="Email preview"
        sandbox=""
        srcDoc={previewDocument(preview.html)}
        className="h-[28rem] w-full rounded-xl border border-border bg-white"
      />
    </div>
  );
}
