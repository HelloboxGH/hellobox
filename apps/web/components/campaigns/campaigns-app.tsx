"use client";

import type { TemplateContact } from "@hellobox/mail/template";
import { AddressBook, ArrowLeft, CodeBlock, DotsThree, Megaphone, Plus, Trash } from "@phosphor-icons/react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Logo } from "@/components/brand";
import { AppProviders } from "@/components/providers";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { ApiError, type Bootstrap, call } from "@/core/client/api";
import { useEntitlementsChanged } from "@/core/client/entitlements-store";
import { notifyError } from "@/core/client/notify";
import { useSearchParam } from "@/core/client/use-search-param";
import { CampaignComposer, sendingMailboxes } from "./campaign-composer";
import { type ContactPage, ContactsTab } from "./contacts-tab";
import { type SavedTemplate, TemplatesTab } from "./templates-tab";

type CampaignRow = Awaited<ReturnType<typeof call<"/campaigns/list">>>[number];

const TABS = [
  { value: "campaigns", label: "Campaigns", icon: <Megaphone /> },
  { value: "contacts", label: "Contacts", icon: <AddressBook /> },
  { value: "templates", label: "Templates", icon: <CodeBlock /> },
];

const STATUS: Record<CampaignRow["status"], { label: string; variant: "secondary" | "info" | "success" | "error" }> = {
  draft: { label: "Draft", variant: "secondary" },
  queued: { label: "Queued", variant: "info" },
  sending: { label: "Sending", variant: "info" },
  sent: { label: "Sent", variant: "success" },
  failed: { label: "Failed", variant: "error" },
};

const formatDate = (value: string | Date) =>
  new Date(value).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

export const toTemplateContact = (contact: ContactPage["contacts"][number]): TemplateContact => ({
  email: contact.email,
  first_name: contact.firstName,
  last_name: contact.lastName,
  fields: contact.fields,
});

function CampaignsList({
  campaigns, canSend, onCompose, onChanged,
}: {
  campaigns: CampaignRow[] | null;
  canSend: boolean;
  onCompose: () => void;
  onChanged: () => void;
}) {
  if (!campaigns) {
    return <div className="space-y-2">{[0, 1, 2].map((row) => <Skeleton key={row} className="h-16 w-full rounded-xl" />)}</div>;
  }
  if (!campaigns.length) {
    return (
      <Empty className="rounded-2xl border bg-card">
        <EmptyHeader>
          <EmptyMedia variant="icon"><Megaphone /></EmptyMedia>
          <EmptyTitle>No campaigns yet</EmptyTitle>
          <EmptyDescription>Send one email to all your subscribed contacts through your email provider. Every campaign carries an unsubscribe link, and opt-outs are honored automatically.</EmptyDescription>
        </EmptyHeader>
        {canSend && <EmptyContent><Button onClick={onCompose}><Plus /> New campaign</Button></EmptyContent>}
      </Empty>
    );
  }
  return (
    <ul className="divide-y overflow-hidden rounded-2xl border bg-card">
      {campaigns.map((campaign) => (
        <li key={campaign.id} className="flex items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium text-foreground text-sm">{campaign.name}</p>
            <p className="truncate text-muted-foreground text-xs">
              {campaign.subject}
              {campaign.from && <> · from {campaign.from}</>}
            </p>
            {campaign.status === "failed" && campaign.error && <p className="mt-1 text-destructive text-xs">{campaign.error}</p>}
          </div>
          <div className="flex flex-col items-end gap-1 text-right">
            <Badge variant={STATUS[campaign.status].variant}>{STATUS[campaign.status].label}</Badge>
            <span className="text-muted-foreground text-xs tabular-nums">
              {campaign.recipientCount !== null && <>{campaign.recipientCount.toLocaleString("en-US")} recipients · </>}
              {campaign.suppressedCount ? (
                <>
                  <Link
                    href="/settings?tab=suppressions"
                    className="underline decoration-dotted underline-offset-2 hover:text-foreground"
                    title="Left out because their address bounced permanently or reported your mail as spam"
                  >
                    {campaign.suppressedCount.toLocaleString("en-US")} skipped
                  </Link>
                  {" · "}
                </>
              ) : null}
              {formatDate(campaign.sentAt ?? campaign.createdAt)}
            </span>
          </div>
          <Menu>
            <MenuTrigger
              render={<Button size="icon-sm" variant="ghost" aria-label={`Actions for ${campaign.name}`} disabled={campaign.status === "queued" || campaign.status === "sending"} />}
            >
              <DotsThree />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem
                variant="destructive"
                onClick={async () => {
                  try {
                    await call("/campaigns/delete", { id: campaign.id });
                    onChanged();
                  } catch (error) {
                    notifyError(error);
                  }
                }}
              >
                <Trash /> Remove from list
              </MenuItem>
            </MenuPopup>
          </Menu>
        </li>
      ))}
    </ul>
  );
}

function Campaigns() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [campaigns, setCampaigns] = useState<CampaignRow[] | null>(null);
  const [templates, setTemplates] = useState<SavedTemplate[] | null>(null);
  const [contactPage, setContactPage] = useState<ContactPage | null>(null);
  const [composing, setComposing] = useState(false);
  const requested = useSearchParam("tab");
  const [chosenTab, setTab] = useState<string | null>(null);
  const tab = chosenTab ?? (TABS.some((item) => item.value === requested) ? (requested as string) : "campaigns");

  const loadBootstrap = useCallback(() => {
    call("/app/bootstrap")
      .then(setData)
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 401) window.location.href = "/login";
      });
  }, []);
  const loadCampaigns = useCallback(() => call("/campaigns/list").then(setCampaigns).catch(notifyError), []);
  const loadTemplates = useCallback(() => call("/templates/list").then(setTemplates).catch(notifyError), []);
  const loadContacts = useCallback(() => call("/contacts/list", {}).then(setContactPage).catch(notifyError), []);

  useEffect(() => {
    loadBootstrap();
    loadCampaigns();
    loadTemplates();
    loadContacts();
  }, [loadBootstrap, loadCampaigns, loadTemplates, loadContacts]);
  useEntitlementsChanged(loadBootstrap);

  // Sending happens in the background, so the list checks back until it's done.
  const inFlight = campaigns?.some((campaign) => campaign.status === "queued" || campaign.status === "sending");
  useEffect(() => {
    if (!inFlight) return;
    const timer = setInterval(loadCampaigns, 4_000);
    return () => clearInterval(timer);
  }, [inFlight, loadCampaigns]);

  const sampleContacts = useMemo(
    () => (contactPage?.contacts ?? []).filter((contact) => !contact.unsubscribedAt).slice(0, 20).map(toTemplateContact),
    [contactPage],
  );
  const subscribed = contactPage ? contactPage.total - contactPage.unsubscribed : 0;
  const canSend = data ? sendingMailboxes(data).length > 0 : false;

  return (
    <main className="min-h-dvh bg-canvas px-4 py-6">
      <div className="mx-auto max-w-5xl">
        <Button variant="ghost" size="sm" className="mb-4 -ms-2" render={<Link href="/inbox" />}><ArrowLeft /> Back to inbox</Button>
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <Logo size={36} />
          <h1 className="flex-1 font-heading font-semibold text-2xl text-foreground tracking-tight">Campaigns</h1>
          {data && canSend && <Button onClick={() => setComposing(true)}><Plus /> New campaign</Button>}
        </div>
        {!data ? (
          <div className="space-y-4"><Skeleton className="h-9 w-full max-w-sm" /><Skeleton className="h-64 w-full rounded-2xl" /></div>
        ) : (
          <>
            {!canSend && (
              <Alert variant="warning" className="mb-4">
                <AlertDescription>
                  Campaigns go out from one of your mailboxes, and none can send yet. Connect Amazon SES or Resend and enable a domain that can send in{" "}
                  <Link className="underline" href="/settings?tab=connection">settings</Link>.
                </AlertDescription>
              </Alert>
            )}
            <Tabs value={tab} onValueChange={(value) => setTab(String(value))}>
              {/* Scrolls sideways on phones; centering an overflowing row would cut off its start. */}
              <div className="-mx-4 mb-4 overflow-x-auto px-4 [scrollbar-width:none]">
                <TabsList className="w-max justify-start *:shrink-0">
                  {TABS.map((item) => <TabsTab key={item.value} value={item.value}>{item.icon} {item.label}</TabsTab>)}
                </TabsList>
              </div>
              <TabsPanel value="campaigns">
                <CampaignsList campaigns={campaigns} canSend={canSend} onCompose={() => setComposing(true)} onChanged={loadCampaigns} />
              </TabsPanel>
              <TabsPanel value="contacts"><ContactsTab onChanged={loadContacts} /></TabsPanel>
              <TabsPanel value="templates">
                <TemplatesTab templates={templates} sampleContact={sampleContacts[0] ?? null} onChanged={loadTemplates} />
              </TabsPanel>
            </Tabs>
            <CampaignComposer
              open={composing}
              onOpenChange={setComposing}
              data={data}
              templates={templates ?? []}
              sampleContacts={sampleContacts}
              subscribed={subscribed}
              onSent={loadCampaigns}
            />
          </>
        )}
      </div>
    </main>
  );
}

export function CampaignsApp() {
  return (
    <AppProviders>
      <Campaigns />
    </AppProviders>
  );
}
