"use client";

import { ArrowLeft } from "@phosphor-icons/react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Logo } from "@/components/brand";
import { AppProviders } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, call } from "@/core/client/api";
import { notifyError } from "@/core/client/notify";
import { toTemplateContact } from "./campaigns-app";
import type { ContactPage } from "./contacts-tab";
import { type SavedTemplate, TemplatesTab } from "./templates-tab";

// Templates are for any email, not only campaigns, so they get their own page too.
function Templates() {
  const [templates, setTemplates] = useState<SavedTemplate[] | null>(null);
  const [contactPage, setContactPage] = useState<ContactPage | null>(null);

  const loadTemplates = useCallback(
    () =>
      call("/templates/list")
        .then(setTemplates)
        .catch((error: unknown) => {
          if (error instanceof ApiError && error.status === 401) window.location.href = "/login";
          else notifyError(error);
        }),
    [],
  );
  useEffect(() => {
    loadTemplates();
    call("/contacts/list", {}).then(setContactPage).catch(() => {});
  }, [loadTemplates]);

  // Previews fill placeholders from a real contact when there is one.
  const sampleContact = useMemo(() => {
    const contact = contactPage?.contacts.find((item) => !item.unsubscribedAt);
    return contact ? toTemplateContact(contact) : null;
  }, [contactPage]);

  return (
    <main className="min-h-dvh bg-canvas px-4 py-6">
      <div className="mx-auto max-w-5xl">
        <Button variant="ghost" size="sm" className="mb-4 -ms-2" render={<Link href="/inbox" />}><ArrowLeft /> Back to inbox</Button>
        <div className="mb-6 flex items-center gap-3">
          <Logo size={36} />
          <h1 className="font-heading font-semibold text-2xl text-foreground tracking-tight">Templates</h1>
        </div>
        {templates === null ? (
          <div className="space-y-4"><Skeleton className="h-9 w-full max-w-sm" /><Skeleton className="h-64 w-full rounded-2xl" /></div>
        ) : (
          <TemplatesTab templates={templates} sampleContact={sampleContact} onChanged={loadTemplates} />
        )}
      </div>
    </main>
  );
}

export function TemplatesApp() {
  return (
    <AppProviders>
      <Templates />
    </AppProviders>
  );
}
