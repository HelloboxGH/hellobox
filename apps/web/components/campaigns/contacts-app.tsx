"use client";

import { ArrowLeft } from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect } from "react";
import { Logo } from "@/components/brand";
import { AppProviders } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { ApiError, call } from "@/core/client/api";
import { ContactsTab } from "./contacts-tab";

// Contacts are for any email, not only campaigns, so they get their own page too.
export function ContactsApp() {
  useEffect(() => {
    call("/contacts/list", {}).catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 401) window.location.href = "/login";
    });
  }, []);
  return (
    <AppProviders>
      <main className="min-h-dvh bg-canvas px-4 py-6">
        <div className="mx-auto max-w-5xl">
          <Button variant="ghost" size="sm" className="mb-4 -ms-2" render={<Link href="/inbox" />}><ArrowLeft /> Back to inbox</Button>
          <div className="mb-6 flex items-center gap-3">
            <Logo size={36} />
            <h1 className="font-heading font-semibold text-2xl text-foreground tracking-tight">Contacts</h1>
          </div>
          <ContactsTab onChanged={() => undefined} />
        </div>
      </main>
    </AppProviders>
  );
}
