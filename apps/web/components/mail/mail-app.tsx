"use client";

import { EnvelopeOpen, PencilSimple, TrayArrowDown, Warning, X } from "@phosphor-icons/react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { PROVIDER_INFO } from "@hellobox/providers/types";
import { Logo } from "@/components/brand";
import { AppProviders } from "@/components/providers";
import { AmazonSesIcon, MailgunIcon, PostmarkIcon, ResendIcon } from "@/components/brand-icons";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { SidebarProvider } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, type Bootstrap, call, clearWorkspaceId, getWorkspaceId, setWorkspaceId } from "@/core/client/api";
import { refreshServiceWorker } from "@/core/client/push";
import { AppTour } from "@/components/onboarding/app-tour";
import { useEntitlementsChanged } from "@/core/client/entitlements-store";
import { errorMessage, notify, notifyError } from "@/core/client/notify";
import { cn } from "@/lib/utils";
import { AiPanel } from "./ai-panel";
import { clientExtensions } from "@/core/client/extensions";
import { MailboxSetup, needsMailboxSetup } from "./mailbox-setup";
import { CommandPalette } from "./command-palette";
import { Composer } from "./composer";
import { ImportDialog, openImportDialog } from "./import-panel";
import { Reader } from "./reader";
import { MailSidebar } from "./sidebar";
import { ThreadList } from "./thread-list";
import type { ComposeState, MailFilter } from "./types";

const { AppBanner } = clientExtensions;

function ConnectPrompt({ data }: { data: Bootstrap }) {
  const reconnect = data.connections.find((c) => c.status === "needs_reconnect");
  const resendHref = `/api/resend/oauth/start?workspace=${data.workspace.id}`;
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyMedia><Logo size={72} /></EmptyMedia>
        <EmptyTitle>{reconnect ? "Reconnect your email provider" : "Connect where you send email from"}</EmptyTitle>
        <EmptyDescription>
          {reconnect
            ? "HelloBox lost access to your provider. Your mail is safe, and new mail will catch up once you reconnect."
            : "Connect Amazon SES, Resend, Postmark or Mailgun. We import your domains and set up receiving, so your mail starts arriving here."}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        {data.role === "member" ? (
          <p className="text-muted-foreground text-sm">Ask a workspace admin to connect a provider.</p>
        ) : reconnect?.provider === "resend" ? (
          <Button data-tour="connect" size="lg" render={<a href={resendHref} />}><ResendIcon /> Reconnect Resend</Button>
        ) : reconnect && reconnect.provider !== "ses" ? (
          <Button data-tour="connect" size="lg" render={<Link href={`/settings?tab=connection&connect=${reconnect.provider}`} />}>
            Reconnect {PROVIDER_INFO[reconnect.provider].name}
          </Button>
        ) : (
          <div data-tour="connect" className="flex flex-wrap justify-center gap-2">
            {data.providers.ses && (
              <Button size="lg" render={<Link href="/settings?tab=connection&connect=ses" />}><AmazonSesIcon className="rounded-[3px]" /> Connect Amazon SES</Button>
            )}
            {!reconnect && (
              <Button size="lg" variant={data.providers.ses ? "outline" : "default"} render={<a href={resendHref} />}><ResendIcon /> Connect Resend</Button>
            )}
            {!reconnect && (
              <Button size="lg" variant="outline" render={<Link href="/settings?tab=connection&connect=postmark" />}><PostmarkIcon /> Connect Postmark</Button>
            )}
            {!reconnect && (
              <Button size="lg" variant="outline" render={<Link href="/settings?tab=connection&connect=mailgun" />}><MailgunIcon className="text-[#F06B66]" /> Connect Mailgun</Button>
            )}
          </div>
        )}
        {/* Old mail can come over before any provider is connected. */}
        <Button variant="ghost" onClick={openImportDialog}><TrayArrowDown /> Or import your old mail first</Button>
      </EmptyContent>
    </Empty>
  );
}

const dismissedKey = (workspaceId: string) => `hellobox.setup-dismissed.${workspaceId}`;

function readDismissed(workspaceId: string) {
  try {
    return localStorage.getItem(dismissedKey(workspaceId));
  } catch {
    return null;
  }
}

// Setup is an admin's job, so members don't see these notices. Dismissing one hides it
// until the situation changes, such as another domain that can't receive.
function SetupBanner({ data }: { data: Bootstrap }) {
  const [dismissed, setDismissed] = useState(() => readDismissed(data.workspace.id));
  if (data.role === "member") return null;
  const notReceiving = data.domains.filter((d) => d.enabled && !d.receivingEnabled);
  const broken = data.connections.find((c) => c.status === "needs_reconnect");
  const signature = broken
    ? `reconnect:${broken.id}`
    : `receiving:${notReceiving.map((d) => d.id).sort().join(",")}`;
  if (signature === dismissed) return null;
  const dismiss = () => {
    try {
      localStorage.setItem(dismissedKey(data.workspace.id), signature);
    } catch {
      // Private windows can refuse storage. It still hides for this visit.
    }
    setDismissed(signature);
  };
  const close = (
    <Button size="icon-xs" variant="ghost" aria-label="Dismiss" onClick={dismiss}><X /></Button>
  );

  if (broken) {
    return (
      <Alert variant="warning" className="rounded-xl">
        <Warning />
        <AlertDescription>
          {broken.provider === "ses"
            ? "HelloBox can't reach your AWS account any more. New mail will catch up after you connect again."
            : `${PROVIDER_INFO[broken.provider].name} access needs renewing. New mail will catch up after you reconnect.`}
        </AlertDescription>
        <AlertAction className="flex items-center gap-1">
          <Button
            size="xs"
            render={broken.provider === "resend"
              ? <a href={`/api/resend/oauth/start?workspace=${data.workspace.id}`} />
              : <Link href={`/settings?tab=connection&connect=${broken.provider}`} />}
          >
            Reconnect
          </Button>
          {close}
        </AlertAction>
      </Alert>
    );
  }
  if (!notReceiving.length) return null;
  const managedHere = new Set(
    data.connections.filter((c) => PROVIDER_INFO[c.provider].receivingInHelloBox).map((c) => c.id),
  );
  const inSettings = notReceiving.filter((d) => managedHere.has(d.connectionId));
  const inResend = notReceiving.filter((d) => !managedHere.has(d.connectionId));
  return (
    <Alert variant="info" className="rounded-xl">
      <Warning />
      <AlertDescription>
        {inResend.length > 0 && <>Receiving is off in Resend for {inResend.map((d) => d.name).join(", ")}. Turn it on in your Resend domain settings and add its MX record. </>}
        {inSettings.length > 0 && <>{inSettings.map((d) => d.name).join(", ")} can send but not receive yet. Turn receiving on in settings.</>}
      </AlertDescription>
      <AlertAction className="flex items-center gap-1">
        {inSettings.length > 0 && <Button size="xs" render={<Link href="/settings?tab=connection" />}>Settings</Button>}
        {close}
      </AlertAction>
    </Alert>
  );
}

function LoadingShell() {
  return (
    <div className="flex h-dvh gap-2 bg-canvas p-2">
      <div className="hidden w-60 space-y-3 p-2 md:block">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-9 w-full" />
        {Array.from({ length: 8 }, (_, index) => <Skeleton key={index} className="h-7 w-full" />)}
      </div>
      <div className="flex-1 rounded-2xl border bg-background lg:max-w-[380px]" />
      <div className="hidden flex-1 rounded-2xl border bg-background lg:block" />
    </div>
  );
}

// Notification links open a conversation: /inbox?workspace=…&thread=…, switching this
// tab to the conversation's workspace first so it never shows in another one's inbox.
// Read once per page load: React may call a state initializer twice, and the URL is
// cleaned after the first. `href` is the link as opened, for signing in and coming back.
let linked: { thread: string | null; href: string | null } | undefined;
function readLink() {
  if (typeof window === "undefined") return { thread: null, href: null };
  if (!linked) {
    const params = new URLSearchParams(window.location.search);
    const workspace = params.get("workspace");
    const deepLink = Boolean(workspace) || params.has("thread");
    if (workspace) setWorkspaceId(workspace);
    linked = { thread: params.get("thread"), href: deepLink ? window.location.pathname + window.location.search : null };
    if (deepLink) window.history.replaceState(null, "", window.location.pathname);
  }
  return linked;
}
const linkedThread = () => readLink().thread;

function App() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [filter, setFilterState] = useState<MailFilter>({ view: "inbox" });
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(linkedThread);
  const [compose, setCompose] = useState<ComposeState | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [touring, setTouring] = useState(false);
  // Opens by itself once there's a domain but no mailbox. Any change in it pins it open
  // until it's closed, so adding the first mailbox doesn't whisk it away mid-setup.
  const [mailboxSetup, setMailboxSetup] = useState<"auto" | "open" | "closed">("auto");
  const [refreshKey, setRefreshKey] = useState(0);
  const threadIds = useRef<string[]>([]);

  useEffect(refreshServiceWorker, []);

  const loadBootstrap = useCallback(
    () =>
      call("/app/bootstrap")
        .then((next) => {
          if (!next.user.onboardedAt) {
            window.location.replace("/onboarding");
            return;
          }
          setData(next);
          const params = new URLSearchParams(window.location.search);
          if (params.has("tour")) {
            setTouring(true);
            params.delete("tour");
            const rest = params.toString();
            window.history.replaceState(null, "", rest ? `/inbox?${rest}` : "/inbox");
          }
          if (getWorkspaceId() !== next.workspace.id) setWorkspaceId(next.workspace.id);
        })
        .catch((error: unknown) => {
          if (error instanceof ApiError && error.status === 401) {
            // A failed verification link lands here, because it redirects to the inbox.
            const failedLink = new URLSearchParams(window.location.search).has("error");
            const back = readLink().href;
            window.location.href = failedLink
              ? "/login?verify=expired"
              : back
                ? `/login?next=${encodeURIComponent(back)}`
                : "/login";
            return;
          }
          // A stale saved workspace falls back to the user's first one.
          if (error instanceof ApiError && error.status === 403 && getWorkspaceId()) {
            clearWorkspaceId();
            window.location.reload();
            return;
          }
          setFailed(errorMessage(error));
        }),
    [],
  );

  const refresh = useCallback(() => {
    setRefreshKey((key) => key + 1);
    return loadBootstrap();
  }, [loadBootstrap]);
  useEntitlementsChanged(refresh);
  const closeTour = useCallback(() => setTouring(false), []);

  useEffect(() => {
    loadBootstrap();
    const status = new URLSearchParams(window.location.search).get("connect");
    if (status) {
      if (status === "ok") notify("Resend connected");
      else if (status === "no-webhook") notify("Resend connected", "Mail will sync every few minutes.");
      else notifyError(new Error(status === "forbidden" ? "Only workspace admins can connect Resend" : "Resend wasn't connected"));
      window.history.replaceState(null, "", "/inbox");
    }
  }, [loadBootstrap]);

  const workspaceId = data?.workspace.id;
  useEffect(() => {
    if (!workspaceId) return;
    const source = new EventSource(`/api/realtime?workspace=${workspaceId}`);
    // A burst of changes (a teammate archiving a page, mail arriving together) reloads once.
    let timer: ReturnType<typeof setTimeout> | undefined;
    source.onmessage = () => {
      clearTimeout(timer);
      timer = setTimeout(refresh, 300);
    };
    return () => {
      clearTimeout(timer);
      source.close();
    };
  }, [workspaceId, refresh]);

  const openCompose = useCallback(
    (state: Omit<ComposeState, "key"> = {}) => setCompose({ key: Date.now(), ...state }),
    [],
  );
  const setFilter = useCallback((next: MailFilter) => {
    setFilterState(next);
    setSelected(null);
    setQuery("");
  }, []);
  const clearSelection = useCallback(() => setSelected(null), []);
  const onThreads = useCallback((ids: string[]) => { threadIds.current = ids; }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      const target = event.target as HTMLElement;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (target.closest("input,textarea,[contenteditable],[role=dialog]")) return;
      if (event.key === "c") {
        event.preventDefault();
        setCompose((current) => current ?? { key: Date.now() });
      } else if (event.key === "/") {
        event.preventDefault();
        document.getElementById("mail-search")?.focus();
      } else if (event.key === "j" || event.key === "k") {
        event.preventDefault();
        setSelected((current) => {
          const ids = threadIds.current;
          if (!ids.length) return current;
          const index = current ? ids.indexOf(current) : -1;
          const next = event.key === "j" ? Math.min(index + 1, ids.length - 1) : Math.max(index - 1, 0);
          return ids[next] ?? current;
        });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (failed) {
    return (
      <Empty className="h-dvh bg-canvas">
        <EmptyHeader>
          <EmptyMedia><Logo size={56} /></EmptyMedia>
          <EmptyTitle>We couldn&apos;t load your inbox</EmptyTitle>
          <EmptyDescription>{failed}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent><Button variant="outline" onClick={() => window.location.reload()}>Try again</Button></EmptyContent>
      </Empty>
    );
  }
  if (!data) return <LoadingShell />;

  const showConnect = !data.connections.some((c) => c.status !== "disconnected");
  // Admins read only what's assigned to them too, so they can also end up with none.
  const settingUp = mailboxSetup === "open" || (mailboxSetup === "auto" && needsMailboxSetup(data));
  const noMailboxes = data.mailboxes.length === 0 && !showConnect && (data.role === "member" || data.managedMailboxes.length > 0);

  return (
    <SidebarProvider className="h-dvh min-h-0 bg-canvas" style={{ "--sidebar-width": "15.5rem" } as React.CSSProperties}>
      <MailSidebar
        data={data}
        filter={filter}
        onFilter={setFilter}
        onCompose={() => openCompose()}
        onRefresh={refresh}
        onOpenThread={setSelected}
      />
      {/* Phones get the whole screen: no frame around the panels, only around the notices. */}
      <main className="flex min-w-0 flex-1 flex-col md:gap-2 md:p-2 md:ps-0">
        {touring && <AppTour onClose={closeTour} />}
        <div className="flex flex-col gap-2 p-2 empty:hidden md:contents">
          {AppBanner && <AppBanner data={data} />}
          {!data.workspace.expiring && <SetupBanner data={data} />}
        </div>
        {settingUp ? (
          <div className="min-h-0 flex-1 overflow-hidden bg-background md:rounded-2xl md:border md:shadow-xs">
            <MailboxSetup data={data} onChanged={() => { setMailboxSetup("open"); refresh(); }} onDone={() => setMailboxSetup("closed")} />
          </div>
        ) : (
        <div className="flex min-h-0 flex-1 gap-2">
          <div className={cn("min-w-0 flex-1 overflow-hidden bg-background md:rounded-2xl md:border md:shadow-xs lg:w-[380px] lg:flex-none lg:shrink-0", selected && "hidden lg:block")}>
            {noMailboxes ? (
              <Empty className="h-full">
                <EmptyHeader>
                  <EmptyMedia><Logo size={72} /></EmptyMedia>
                  <EmptyTitle>You don&apos;t have a mailbox yet</EmptyTitle>
                  <EmptyDescription>
                    {data.role === "member"
                      ? "Ask a workspace admin to give you access under Settings, then Team."
                      : "Mailboxes aren't open to admins by default. Give yourself the shared ones you need under Settings, then Team."}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : showConnect && data.mailboxes.length === 0 ? (
              <ConnectPrompt data={data} />
            ) : (
              <ThreadList
                filter={filter}
                query={query}
                onQuery={setQuery}
                selectedId={selected}
                refreshKey={refreshKey}
                labels={data.labels}
                onSelect={setSelected}
                onCompose={openCompose}
                onChanged={refresh}
                onThreads={onThreads}
              />
            )}
          </div>
          <div className={cn("min-w-0 flex-1 overflow-hidden bg-background md:rounded-2xl md:border md:shadow-xs", !selected && "hidden lg:block")}>
            {selected ? (
              <Reader
                key={selected}
                threadId={selected}
                data={data}
                refreshKey={refreshKey}
                onBack={clearSelection}
                onCompose={openCompose}
                onChanged={refresh}
                onToggleAi={() => setAiOpen((open) => !open)}
              />
            ) : (
              <Empty className="h-full">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><EnvelopeOpen /></EmptyMedia>
                  <EmptyTitle>Pick a conversation</EmptyTitle>
                  <EmptyDescription className="flex flex-wrap items-center justify-center gap-1.5">
                    Move with <KbdGroup><Kbd>J</Kbd><Kbd>K</Kbd></KbdGroup> or press <KbdGroup><Kbd>⌘</Kbd><Kbd>K</Kbd></KbdGroup> to do anything.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </div>
        </div>
        )}
      </main>

      {!selected && !compose && !showConnect && !settingUp && (
        <Button
          aria-label="Compose"
          size="icon-xl"
          className="fixed right-5 bottom-5 z-20 rounded-full shadow-lg md:hidden"
          onClick={() => openCompose()}
        >
          <PencilSimple weight="bold" />
        </Button>
      )}
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        data={data}
        onFilter={setFilter}
        onCompose={() => openCompose()}
        onSearch={(text) => {
          setFilterState({ view: "all" });
          setSelected(null);
          setQuery(text);
        }}
      />
      {aiOpen && (
        <AiPanel
          threadId={selected}
          onClose={() => setAiOpen(false)}
          onUseDraft={(html) => {
            setCompose((current) =>
              current ? { ...current, key: Date.now(), html } : { key: Date.now(), html, mailboxId: data.mailboxes[0]?.id },
            );
          }}
        />
      )}
      <ImportDialog data={data} onChanged={refresh} />
      {compose && (
        <Composer
          key={compose.key}
          initial={compose}
          data={data}
          onClose={() => setCompose(null)}
          onMailboxCreated={refresh}
          onSent={(restore) => {
            refresh();
            if (restore) openCompose(restore);
          }}
        />
      )}
    </SidebarProvider>
  );
}

export function MailApp() {
  return (
    <AppProviders>
      <App />
    </AppProviders>
  );
}
