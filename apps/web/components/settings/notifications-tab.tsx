"use client";

import {
  Browser, EnvelopeSimple, PaperPlaneTilt, Trash, WebhooksLogo,
} from "@phosphor-icons/react";
import { type ComponentType, type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import QRCode from "react-qr-code";
import { DiscordIcon, NtfyIcon, SlackIcon, TelegramIcon } from "@/components/brand-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { type Bootstrap, call, type Output } from "@/core/client/api";
import { notify, notifyError } from "@/core/client/notify";
import { currentPushEndpoint, deviceName, needsHomeScreen, pushSupported, subscribeToPush } from "@/core/client/push";
import { useSearchParam } from "@/core/client/use-search-param";
import { Section, useRun } from "./shared";

type Info = Output<"/notifications/get">;
type Channel = Info["channels"][number];
type Kind = Channel["kind"];

const KINDS: Record<Kind, { name: string; icon: ComponentType<{ className?: string }> }> = {
  email: { name: "Email", icon: EnvelopeSimple },
  discord: { name: "Discord", icon: DiscordIcon },
  slack: { name: "Slack", icon: SlackIcon },
  telegram: { name: "Telegram", icon: TelegramIcon },
  ntfy: { name: "ntfy", icon: NtfyIcon },
  webhook: { name: "Webhook", icon: WebhooksLogo },
  browser: { name: "Browser", icon: Browser },
};

const CONNECTED: Record<string, string> = {
  connected: "Connected. Send a test to check it.",
  denied: "Connecting was cancelled.",
  forbidden: "You don't have access to that workspace.",
  full: "You've reached the limit of 20 channels.",
  failed: "That didn't work. Try again, or paste a webhook URL instead.",
};

// ntfy's apps open these links and subscribe in one tap.
const ntfyLink = (server: string, topic: string) => `ntfy://${new URL(server).host}/${topic}`;

// In onboarding it shows only the channels, and Discord and Slack come back there.
export function NotificationsTab({ data, onboarding = false }: { data: Bootstrap; onboarding?: boolean }) {
  const run = useRun();
  const [info, setInfo] = useState<Info | null>(null);
  const [paste, setPaste] = useState<"discord" | "slack" | "webhook" | null>(null);
  const [ntfyOpen, setNtfyOpen] = useState(false);
  const [subscribe, setSubscribe] = useState<{ server: string; topic: string } | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [thisBrowser, setThisBrowser] = useState<string | null>(null);
  const waiting = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(() => call("/notifications/get").then(setInfo).catch(notifyError), []);
  useEffect(() => {
    void load();
    void currentPushEndpoint().then(setThisBrowser).catch(() => undefined);
    return () => {
      if (waiting.current) clearInterval(waiting.current);
    };
  }, [load]);

  // Back from "Connect Discord" or "Add to Slack".
  const connected = useSearchParam("connected");
  const status = useSearchParam("status");
  useEffect(() => {
    if (!connected || !status) return;
    const message = CONNECTED[status];
    if (message && status === "connected") notify(message);
    else if (message) notifyError(new Error(message));
    window.history.replaceState(null, "", onboarding ? "/onboarding?step=notifications" : "/settings?tab=notifications");
  }, [connected, status, onboarding]);

  if (!info) return <Skeleton className="h-64 w-full rounded-2xl" />;

  const has = (kind: Kind) => info.channels.some((channel) => channel.kind === kind);
  const workspace = `${encodeURIComponent(data.workspace.id)}${onboarding ? "&from=onboarding" : ""}`;

  async function connectTelegram() {
    const before = info?.channels.length ?? 0;
    try {
      const { url } = await call("/notifications/telegram/link");
      window.open(url, "_blank", "noopener");
    } catch (error) {
      notifyError(error);
      return;
    }
    // Pressing Start in Telegram links the chat on our side; watch for it for two minutes.
    if (waiting.current) clearInterval(waiting.current);
    let ticks = 0;
    waiting.current = setInterval(async () => {
      ticks += 1;
      const next = await call("/notifications/get").catch(() => null);
      if (next) setInfo(next);
      if ((next && next.channels.length > before) || ticks >= 40) {
        if (waiting.current) clearInterval(waiting.current);
        if (next && next.channels.length > before) notify("Telegram connected");
      }
    }, 3_000);
  }

  async function turnOnBrowser() {
    if (!info?.available.browser) return;
    try {
      const subscription = await subscribeToPush(info.available.browser);
      await call("/notifications/channels/add", { kind: "browser", subscription, device: deviceName() });
      setThisBrowser(subscription.endpoint);
      notify("Notifications on in this browser");
      void load();
    } catch (error) {
      notifyError(error);
    }
  }

  async function quickNtfy() {
    try {
      const { id } = await call("/notifications/channels/add", { kind: "ntfy" });
      const next = await call("/notifications/get");
      setInfo(next);
      const made = next.channels.find((channel) => channel.id === id);
      if (made?.ntfy) setSubscribe(made.ntfy);
    } catch (error) {
      notifyError(error);
    }
  }

  const adders: { kind: Kind; description: string; actions: { label: string; onClick: () => void; primary?: boolean }[]; hidden?: boolean }[] = [
    {
      kind: "email",
      hidden: has("email"),
      description: info.instantEmail
        ? `An email to ${data.user.email} as soon as mail arrives, with the sender, recipient and a preview. A burst comes as one email.`
        : `On the Solo plan: at most one email an hour to ${data.user.email}, only saying you have new messages, with no sender or preview. Paid plans get a detailed email for each message.`,
      actions: [{ label: "Turn on", primary: true, onClick: () => run(() => call("/notifications/channels/add", { kind: "email" }).then(load), "Email notifications on") }],
    },
    {
      kind: "discord",
      description: "Posts to a channel in your server, as soon as mail arrives.",
      actions: [
        ...(info.available.discord ? [{ label: "Connect Discord", primary: true, onClick: () => window.location.assign(`/api/notifications/oauth/discord/start?workspace=${workspace}`) }] : []),
        { label: "Paste a webhook URL", onClick: () => setPaste("discord") },
      ],
    },
    {
      kind: "slack",
      description: "Posts to a channel in your workspace, as soon as mail arrives.",
      actions: [
        ...(info.available.slack ? [{ label: "Add to Slack", primary: true, onClick: () => window.location.assign(`/api/notifications/oauth/slack/start?workspace=${workspace}`) }] : []),
        { label: "Paste a webhook URL", onClick: () => setPaste("slack") },
      ],
    },
    {
      kind: "telegram",
      hidden: !info.available.telegram,
      description: "A message from the HelloBox bot, in a chat or a group.",
      actions: [{ label: "Connect Telegram", primary: true, onClick: connectTelegram }],
    },
    {
      kind: "browser",
      hidden: !info.available.browser || !pushSupported(),
      description: needsHomeScreen()
        ? "On iPhone and iPad, add HelloBox to your Home Screen first (Share, then Add to Home Screen), then turn this on there."
        : "A notification on this device, even with HelloBox closed. Turn it on in each browser you use.",
      actions: thisBrowser && info.channels.some((c) => c.endpoint === thisBrowser)
        ? []
        : [{ label: "Turn on in this browser", primary: true, onClick: turnOnBrowser }],
    },
    {
      kind: "ntfy",
      description: "Free phone notifications through the ntfy app, without an account.",
      actions: [
        ...(info.available.ntfy ? [{ label: "Set up", primary: true, onClick: quickNtfy }] : []),
        { label: info.available.ntfy ? "Use my own server" : "Set up", onClick: () => setNtfyOpen(true) },
      ],
    },
    {
      kind: "webhook",
      description: "A signed JSON POST to your URL. Works with Zapier, n8n, Make and Mattermost.",
      actions: [{ label: "Add a webhook", primary: true, onClick: () => setPaste("webhook") }],
    },
  ];

  return (
    <div className="space-y-4">
      <Section
        title="Where you get notified"
        description="New mail in the inboxes you can read. Spam never notifies, and mail that arrives in a burst comes as one message."
      >
        {info.channels.length === 0 && <p className="text-muted-foreground text-sm">Nothing yet. Pick a channel below.</p>}
        <ul className="divide-y">
          {info.channels.map((channel) => (
            <ChannelRow
              key={channel.id}
              channel={channel}
              digest={channel.kind === "email" && !info.instantEmail}
              onChanged={load}
              onSubscribe={channel.ntfy ? () => setSubscribe(channel.ntfy) : undefined}
            />
          ))}
        </ul>
      </Section>

      <Section title="Add a channel">
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {adders.filter((adder) => !adder.hidden).map((adder) => {
            const Icon = KINDS[adder.kind].icon;
            return (
              <li key={adder.kind} className="flex min-w-0 flex-col gap-3 rounded-xl border p-3">
                <div className="flex items-start gap-3">
                  <Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="font-medium text-foreground text-sm">{KINDS[adder.kind].name}</p>
                    <p className="break-words text-muted-foreground text-xs">{adder.description}</p>
                  </div>
                </div>
                {adder.actions.length > 0 && (
                  <div className="mt-auto flex flex-wrap gap-2">
                    {adder.actions.map((action) => (
                      <Button key={action.label} size="sm" variant={action.primary ? "outline" : "ghost"} onClick={action.onClick}>
                        {action.label}
                      </Button>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </Section>

      {!onboarding && <WhatNotifies info={info} onChanged={load} />}
      {!onboarding && info.teamEmails && <TeamEmails info={info} onChanged={load} />}

      <PasteDialog kind={paste} onClose={() => setPaste(null)} onAdded={(made) => { setPaste(null); if (made) setSecret(made); void load(); }} />
      <NtfyDialog open={ntfyOpen} ours={info.available.ntfy} onClose={() => setNtfyOpen(false)} onAdded={(made) => { setNtfyOpen(false); void load(); if (made) setSubscribe(made); }} />

      <Dialog open={!!subscribe} onOpenChange={(open) => !open && setSubscribe(null)}>
        <DialogPopup className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Subscribe in the ntfy app</DialogTitle>
            <DialogDescription>
              Install ntfy on your phone, then scan this code or open the link there. You can also add it by hand: tap +, turn on
              &quot;Use another server&quot;, and enter the server and topic below.
            </DialogDescription>
          </DialogHeader>
          {subscribe && (
            <DialogPanel className="space-y-3">
              {/* eslint-disable-next-line hellobox/no-hard-coded-colors -- QR codes need a white quiet zone to scan, in both themes */}
              <div className="mx-auto w-fit rounded-xl border bg-white p-3"><QRCode value={ntfyLink(subscribe.server, subscribe.topic)} size={160} /></div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                <dt className="text-muted-foreground">Server</dt><dd className="break-all font-mono">{subscribe.server}</dd>
                <dt className="text-muted-foreground">Topic</dt><dd className="break-all font-mono">{subscribe.topic}</dd>
              </dl>
              <p className="text-muted-foreground text-xs">
                Anyone who knows this topic can read it, so keep it to yourself. That&apos;s why details start off here: notifications only say new mail arrived. Turn on Show details if you&apos;d rather see the sender and the first lines.
              </p>
            </DialogPanel>
          )}
          <DialogFooter>
            {subscribe && <Button variant="outline" render={<a href={ntfyLink(subscribe.server, subscribe.topic)} />}>Open in ntfy</Button>}
            <Button onClick={() => setSubscribe(null)}>Done</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog open={!!secret} onOpenChange={(open) => !open && setSecret(null)}>
        <DialogPopup className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Your webhook signing secret</DialogTitle>
            <DialogDescription>
              Copy it now: we won&apos;t show it again. Each request carries X-HelloBox-Timestamp and X-HelloBox-Signature, which is
              v1= and the HMAC-SHA256 of &quot;timestamp.body&quot; with this secret.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel><Input readOnly value={secret ?? ""} className="font-mono" onFocus={(event) => event.target.select()} /></DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => secret && navigator.clipboard.writeText(secret).then(() => notify("Copied"))}>Copy</Button>
            <Button onClick={() => setSecret(null)}>Done</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

function ChannelRow({ channel, digest, onChanged, onSubscribe }: { channel: Channel; digest: boolean; onChanged: () => void; onSubscribe?: () => void }) {
  const run = useRun();
  const Icon = KINDS[channel.kind].icon;
  const update = (patch: { enabled?: boolean; preview?: boolean }) =>
    run(() => call("/notifications/channels/update", { id: channel.id, ...patch }).then(onChanged));
  return (
    <li className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
      <Icon className="size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-40 flex-1">
        <p className="flex items-center gap-2 text-foreground text-sm">
          <span className="truncate">{channel.label}</span>
          {digest && <Badge variant="secondary" size="sm">Hourly notice</Badge>}
          {!channel.enabled && <Badge variant="warning" size="sm">Off</Badge>}
        </p>
        {digest && (
          <p className="text-muted-foreground text-xs">
            Solo plan: an hourly heads-up with no details. Upgrade for a detailed email per message.
          </p>
        )}
        {!digest && (
          <p className="text-muted-foreground text-xs">
            {channel.preview
              ? "Shows the sender, recipient and the first lines of each message."
              : "Only says new mail arrived, with a link. Nothing from the message itself."}
          </p>
        )}
        {channel.disabledReason ? (
          <p className="text-destructive-foreground text-xs">{channel.disabledReason}</p>
        ) : (
          <p className="text-muted-foreground text-xs">
            {channel.lastSentAt ? `Last sent ${new Date(channel.lastSentAt).toLocaleString()}` : "Nothing sent yet"}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {!digest && (
          <Label className="flex items-center gap-2 text-xs">
            <Switch checked={channel.preview} onCheckedChange={(preview) => update({ preview })} />
            Show details
          </Label>
        )}
        <Label className="flex items-center gap-2 text-xs">
          <Switch checked={channel.enabled} onCheckedChange={(enabled) => update({ enabled })} />
          On
        </Label>
        {onSubscribe && <Button size="sm" variant="ghost" onClick={onSubscribe}>Subscribe</Button>}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => run(() => call("/notifications/channels/test", { id: channel.id }).then(() => setTimeout(onChanged, 4_000)), "Test sent. It should arrive in a few seconds.")}
        >
          <PaperPlaneTilt /> Test
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Remove ${channel.label}`}
          onClick={() => run(() => call("/notifications/channels/remove", { id: channel.id }).then(onChanged), "Removed")}
        >
          <Trash />
        </Button>
      </div>
    </li>
  );
}

// Separate from the channels above: these go to the account's email address, and always
// show under Notifications in the app.
function TeamEmails({ info, onChanged }: { info: Info; onChanged: () => void }) {
  const run = useRun();
  const [enabled, setEnabled] = useState(info.settings.teamEmails);
  return (
    <Section title="From your team" description="These show under Notifications in the app either way.">
      <Label className="flex items-center justify-between gap-4">
        <span className="space-y-0.5">
          <span className="block font-medium text-foreground text-sm">Email me when I&apos;m assigned or mentioned</span>
          <span className="block text-muted-foreground text-xs">Sent to your account&apos;s email, unless you open it in HelloBox first.</span>
        </span>
        <Switch
          checked={enabled}
          onCheckedChange={(next) => {
            setEnabled(next);
            void run(() => call("/notifications/team-emails", { enabled: next }).then(onChanged));
          }}
        />
      </Label>
    </Section>
  );
}

function WhatNotifies({ info, onChanged }: { info: Info; onChanged: () => void }) {
  const run = useRun();
  const [all, setAll] = useState(info.settings.mailboxIds === null);
  const [picked, setPicked] = useState<string[]>(info.settings.mailboxIds ?? info.mailboxes.map((m) => m.id));
  const [primaryOnly, setPrimaryOnly] = useState(info.settings.primaryOnly);
  const save = (next: { all: boolean; picked: string[]; primaryOnly: boolean }) =>
    run(() => call("/notifications/settings", { mailboxIds: next.all ? null : next.picked, primaryOnly: next.primaryOnly }).then(onChanged));
  return (
    <Section title="What notifies you" description="These apply to every channel above.">
      <Label className="flex items-center justify-between gap-4">
        <span className="space-y-0.5">
          <span className="block font-medium text-foreground text-sm">Only Primary</span>
          <span className="block text-muted-foreground text-xs">Skip alerts, newsletters and purchases.</span>
        </span>
        <Switch checked={primaryOnly} onCheckedChange={(next) => { setPrimaryOnly(next); void save({ all, picked, primaryOnly: next }); }} />
      </Label>
      <Label className="flex items-center justify-between gap-4">
        <span className="space-y-0.5">
          <span className="block font-medium text-foreground text-sm">All my mailboxes</span>
          <span className="block text-muted-foreground text-xs">Including ones you get access to later.</span>
        </span>
        <Switch checked={all} onCheckedChange={(next) => { setAll(next); void save({ all: next, picked, primaryOnly }); }} />
      </Label>
      {!all && (
        <ul className="grid gap-2 sm:grid-cols-2">
          {info.mailboxes.length === 0 && <li className="text-muted-foreground text-sm">You can&apos;t read any mailboxes here yet.</li>}
          {info.mailboxes.map((mailbox) => (
            <li key={mailbox.id}>
              <Label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={picked.includes(mailbox.id)}
                  onCheckedChange={(checked) => {
                    const next = checked ? [...picked, mailbox.id] : picked.filter((id) => id !== mailbox.id);
                    setPicked(next);
                    void save({ all, picked: next, primaryOnly });
                  }}
                />
                <span className="truncate">{mailbox.address}</span>
              </Label>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

const PASTE_COPY = {
  discord: {
    title: "Paste a Discord webhook",
    help: "In Discord: Server Settings → Integrations → Webhooks → New Webhook. Pick the channel, then Copy Webhook URL.",
    placeholder: "https://discord.com/api/webhooks/…",
  },
  slack: {
    title: "Paste a Slack webhook",
    help: "At api.slack.com/apps: create an app, turn on Incoming Webhooks, Add New Webhook to Workspace, pick a channel and copy the URL.",
    placeholder: "https://hooks.slack.com/services/…",
  },
  webhook: {
    title: "Add a webhook",
    help: "We POST JSON to this address for each new message, signed with a secret you'll see next.",
    placeholder: "https://example.com/hellobox",
  },
};

function PasteDialog({ kind, onClose, onAdded }: { kind: "discord" | "slack" | "webhook" | null; onClose: () => void; onAdded: (secret: string | null) => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const copy = kind ? PASTE_COPY[kind] : null;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!kind) return;
    setBusy(true);
    try {
      const { secret } = await call("/notifications/channels/add", { kind, url });
      setUrl("");
      notify("Added. Send a test to check it.");
      onAdded(secret);
    } catch (error) {
      notifyError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={!!kind} onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="sm:max-w-md">
        <Form className="contents" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{copy?.title}</DialogTitle>
            <DialogDescription>{copy?.help}</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Field>
              <FieldLabel>URL</FieldLabel>
              <Input required type="url" autoFocus value={url} placeholder={copy?.placeholder} onChange={(event) => setUrl(event.target.value)} />
            </Field>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={busy}>Add</Button>
          </DialogFooter>
        </Form>
      </DialogPopup>
    </Dialog>
  );
}

function NtfyDialog({ open, ours, onClose, onAdded }: { open: boolean; ours: string | null; onClose: () => void; onAdded: (subscribe: { server: string; topic: string } | null) => void }) {
  const [server, setServer] = useState("");
  const [topic, setTopic] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      const { id } = await call("/notifications/channels/add", {
        kind: "ntfy",
        server: server || undefined,
        topic: topic || undefined,
        token: token || undefined,
      });
      const made = (await call("/notifications/get")).channels.find((channel) => channel.id === id);
      setServer("");
      setTopic("");
      setToken("");
      onAdded(made?.ntfy ?? null);
    } catch (error) {
      notifyError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogPopup className="sm:max-w-md">
        <Form className="contents" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Your own ntfy server</DialogTitle>
            <DialogDescription>For ntfy.sh with your own account, or a server you run. Leave the topic empty and we&apos;ll make a hard-to-guess one.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <Field>
              <FieldLabel>Server</FieldLabel>
              <Input required={!ours} type="url" value={server} placeholder={ours ?? "https://ntfy.sh"} onChange={(event) => setServer(event.target.value)} />
            </Field>
            <Field>
              <FieldLabel>Topic</FieldLabel>
              <Input value={topic} placeholder="Made for you" onChange={(event) => setTopic(event.target.value)} />
            </Field>
            <Field>
              <FieldLabel>Access token</FieldLabel>
              <Input value={token} placeholder="tk_…" onChange={(event) => setToken(event.target.value)} />
              <FieldDescription>Needed if your server only lets signed-in accounts publish. On ntfy.sh, it also puts the sending on your account&apos;s limits.</FieldDescription>
            </Field>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={busy}>Add</Button>
          </DialogFooter>
        </Form>
      </DialogPopup>
    </Dialog>
  );
}
