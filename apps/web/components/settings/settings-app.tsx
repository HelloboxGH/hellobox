"use client";

import { ArrowLeft, BellRinging, ChatCircleText, Chats, Globe, LockKey, ListChecks, Prohibit, Robot, Sparkle, Tray, UserCircle, UsersThree } from "@phosphor-icons/react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Logo } from "@/components/brand";
import { NotificationsTab } from "./notifications-tab";
import { EncryptionTab } from "./encryption";
import { AppProviders } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { ApiError, type Bootstrap, call } from "@/core/client/api";
import { useEntitlementsChanged } from "@/core/client/entitlements-store";
import { clientExtensions } from "@/core/client/extensions";
import { useSearchParam } from "@/core/client/use-search-param";
import { FeedbackContent } from "@/components/feedback";
import { Section } from "./shared";
import { SupportTab } from "./support-tab";
import { AccountTab } from "./tabs/account-tab";
import { AgentsTab } from "./tabs/agents-tab";
import { AiTab } from "./tabs/ai-tab";
import { ConnectionTab } from "./tabs/domains-tab";
import { MailboxesTab } from "./tabs/mailboxes-tab";
import { RulesTab } from "./tabs/rules-tab";
import { SuppressionsTab } from "./tabs/suppressions-tab";
import { TeamTab } from "./tabs/team-tab";

const TABS = [
  { value: "account", label: "Account", icon: <UserCircle /> },
  { value: "connection", label: "Domains", icon: <Globe /> },
  { value: "mailboxes", label: "Mailboxes", icon: <Tray /> },
  { value: "team", label: "Team", icon: <UsersThree /> },
  { value: "notifications", label: "Notifications", icon: <BellRinging /> },
  { value: "encryption", label: "Encryption", icon: <LockKey /> },
  { value: "rules", label: "Rules", icon: <ListChecks /> },
  { value: "suppressions", label: "Suppressed", icon: <Prohibit /> },
  { value: "ai", label: "AI", icon: <Sparkle /> },
  { value: "support", label: "Support", icon: <Chats /> },
  { value: "agents", label: "Agents", icon: <Robot /> },
  { value: "feedback", label: "Feedback", icon: <ChatCircleText /> },
];

// The open tabs with the cloud build's added after the one each names.
const cloudTabs = clientExtensions.settingsTabs ?? [];
const ALL_TABS = [
  ...TABS.flatMap((tab) => [tab, ...cloudTabs.filter((extra) => extra.after === tab.value)]),
  ...cloudTabs.filter((extra) => !TABS.some((tab) => tab.value === extra.after)),
];

function Settings() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const requested = useSearchParam("tab");
  const [chosenTab, setTab] = useState<string | null>(null);
  const tab = chosenTab ?? (ALL_TABS.some((item) => item.value === requested) ? (requested as string) : "account");
  const refresh = useCallback(() => {
    call("/app/bootstrap")
      .then(setData)
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 401) window.location.href = "/login";
      });
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  useEntitlementsChanged(refresh);

  return (
    <main className="min-h-dvh bg-canvas px-4 py-6">
      <div className="mx-auto max-w-4xl">
        <Button variant="ghost" size="sm" className="mb-4 -ms-2" render={<Link href="/inbox" />}><ArrowLeft /> Back to inbox</Button>
        <div className="mb-6 flex items-center gap-3">
          <Logo size={36} />
          <h1 className="font-heading font-semibold text-2xl text-foreground tracking-tight">Settings</h1>
        </div>
        {!data ? (
          <div className="space-y-4"><Skeleton className="h-9 w-full max-w-lg" /><Skeleton className="h-64 w-full rounded-2xl" /></div>
        ) : (
          <Tabs value={tab} onValueChange={(value) => setTab(String(value))}>
            {/* Scrolls sideways on phones; centering an overflowing row would cut off its start. */}
            <div className="-mx-4 mb-4 overflow-x-auto px-4 [scrollbar-width:none]">
              <TabsList className="w-max justify-start *:shrink-0">
                {ALL_TABS.map((item) => <TabsTab key={item.value} value={item.value}>{item.icon} {item.label}</TabsTab>)}
              </TabsList>
            </div>
            <TabsPanel value="account"><AccountTab data={data} refresh={refresh} /></TabsPanel>
            <TabsPanel value="connection"><ConnectionTab data={data} refresh={refresh} /></TabsPanel>
            <TabsPanel value="mailboxes"><MailboxesTab data={data} refresh={refresh} /></TabsPanel>
            <TabsPanel value="team"><TeamTab data={data} refresh={refresh} /></TabsPanel>
            <TabsPanel value="notifications"><NotificationsTab data={data} /></TabsPanel>
            <TabsPanel value="encryption"><EncryptionTab /></TabsPanel>
            <TabsPanel value="rules"><RulesTab admin={data.role !== "member"} /></TabsPanel>
            <TabsPanel value="suppressions"><SuppressionsTab admin={data.role !== "member"} /></TabsPanel>
            <TabsPanel value="ai"><AiTab /></TabsPanel>
            <TabsPanel value="support"><SupportTab admin={data.role !== "member"} refresh={refresh} onTab={setTab} /></TabsPanel>
            <TabsPanel value="agents"><AgentsTab data={data} /></TabsPanel>
            <TabsPanel value="feedback">
              <Section title="Feedback and contact" description="Ideas, bugs or questions go straight to the people who build HelloBox. We reply to your account email.">
                <FeedbackContent className="max-w-xl" />
              </Section>
            </TabsPanel>
            {cloudTabs.map(({ value, Panel }) => <TabsPanel key={value} value={value}><Panel data={data} refresh={refresh} /></TabsPanel>)}
          </Tabs>
        )}
      </div>
    </main>
  );
}

export function SettingsApp() {
  return (
    <AppProviders>
      <Settings />
    </AppProviders>
  );
}
