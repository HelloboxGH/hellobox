"use client";

import { Chats, DotsThree, Key, Plus, WarningCircle } from "@phosphor-icons/react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Callout } from "@/components/callout";
import { Segmented } from "@/components/segmented";
import {
  AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { call } from "@/core/client/api";
import { errorMessage } from "@/core/client/notify";
import { supportCurl, supportNode, supportPrompt } from "@/core/support-setup";
import { CopyButton, Section, useRun, useRunning } from "./shared";

type Support = Awaited<ReturnType<typeof call<"/support/inboxes">>>;
type Inbox = Support["inboxes"][number];

const formatDay = (value: string | Date) => new Date(value).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

const WAYS = [
  { value: "prompt", label: "AI coding tool" },
  { value: "node", label: "Node.js" },
  { value: "curl", label: "Try it now" },
] as const;

const WAY_HINTS = {
  prompt: "Paste this into Claude Code, Cursor or another coding tool, in your app's folder.",
  node: "Call this from your server when someone sends your form.",
  curl: "Paste this into a terminal, with your own email address. The message shows up in HelloBox, ready to answer.",
};

// Only shown after a click, so this never renders on the server.
function SetupCode({ apiKey }: { apiKey: string }) {
  const [way, setWay] = useState<(typeof WAYS)[number]["value"]>("prompt");
  const { origin } = window.location;
  const code = { prompt: supportPrompt(origin), node: supportNode(origin), curl: supportCurl(origin, apiKey) }[way];
  return (
    <div className="space-y-3">
      <Segmented label="How to add it" value={way} onChange={setWay} options={[...WAYS]} />
      <p className="text-muted-foreground text-sm">{WAY_HINTS[way]}</p>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-3 font-mono text-xs leading-relaxed">{code}</pre>
      <CopyButton value={code} />
    </div>
  );
}

function Confirm({ title, body, action, onConfirm, open, onOpenChange }: {
  title: string; body: string; action: string; onConfirm: () => void; open: boolean; onOpenChange: (open: boolean) => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>Keep it</AlertDialogClose>
          <AlertDialogClose render={<Button variant="destructive" />} onClick={onConfirm}>{action}</AlertDialogClose>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

// Where the app hears about new messages and status changes. The secret is shown once.
function Webhook({ inbox, reload }: { inbox: Inbox; reload: () => void }) {
  const [busy, start] = useRunning();
  const [url, setUrl] = useState(inbox.webhook?.url ?? "");
  const [secret, setSecret] = useState<string | null>(null);
  const saved = inbox.webhook?.url ?? "";
  const save = (next: string | null) =>
    start(async () => {
      const result = await call("/support/webhook", { inboxId: inbox.id, url: next });
      if (result.secret) setSecret(result.secret);
      if (!next) setUrl("");
      reload();
    });
  return (
    <div className="space-y-2 border-t pt-4">
      <Form
        className="space-y-2"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          void save(url.trim() || null);
        }}
      >
        <Field>
          <FieldLabel>Webhook</FieldLabel>
          <div className="flex w-full flex-wrap gap-2">
            <Input
              className="min-w-0 flex-1 basis-60"
              type="url"
              inputMode="url"
              placeholder="https://your-app.com/hellobox"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
            <Button type="submit" variant="outline" loading={busy} disabled={url.trim() === saved}>Save</Button>
          </div>
          <FieldDescription>Your server hears when a customer writes, you reply, or a status changes.</FieldDescription>
        </Field>
      </Form>
      {inbox.webhook?.error && (
        <Callout tone="warning" icon={<WarningCircle />} title="Your webhook isn't answering">
          The last try failed: {inbox.webhook.error}. Events are tried again for a day.
        </Callout>
      )}
      {inbox.webhook && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" loading={busy} onClick={() => start(async () => setSecret((await call("/support/webhook/secret", { inboxId: inbox.id })).secret))}>
            New secret
          </Button>
          <Button size="sm" variant="ghost" loading={busy} onClick={() => void save(null)}>Remove webhook</Button>
        </div>
      )}
      <Dialog open={secret !== null} onOpenChange={(open) => { if (!open) setSecret(null); }}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Your webhook secret</DialogTitle>
            <DialogDescription>Copy it now: you won&apos;t see it again. Check the X-HelloBox-Signature of every event with it.</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-lg bg-muted p-2 font-mono text-xs">{secret}</code>
              {secret && <CopyButton value={secret} />}
            </div>
          </DialogPanel>
          <DialogFooter><Button onClick={() => setSecret(null)}>Done</Button></DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

function InboxSection({ inbox, reload, onKey, onTab }: {
  inbox: Inbox; reload: () => void; onKey: (key: string) => void; onTab: (tab: string) => void;
}) {
  const run = useRun();
  const [busy, start] = useRunning();
  const [confirming, setConfirming] = useState(false);
  const [revoking, setRevoking] = useState<Inbox["keys"][number] | null>(null);
  const [showing, setShowing] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  return (
    <Section title={inbox.name} description={inbox.address ? `Conversations arrive in ${inbox.address}. Whoever can read that mailbox can answer them.` : undefined}>
      {inbox.problem ? (
        <Callout tone="warning" icon={<WarningCircle />} title="Messages are being refused">{inbox.problem}</Callout>
      ) : !inbox.receiving && (
        <Callout
          tone="warning"
          icon={<WarningCircle />}
          title="You won't get answers by email yet"
          actions={<Button size="sm" variant="outline" onClick={() => onTab("connection")}>Open Domains</Button>}
        >
          Your replies go out from {inbox.address}, but {inbox.domain} doesn&apos;t receive mail in HelloBox. Turn on receiving, or customers&apos; answers go elsewhere.
        </Callout>
      )}
      <ul className="divide-y">
        {inbox.keys.map((key) => (
          <li key={key.id} className="flex items-center gap-3 py-2.5 text-sm">
            <Key className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 font-medium text-foreground">
                <span className="truncate">{key.name}</span>
                <code className="font-mono font-normal text-muted-foreground text-xs">{key.prefix}…</code>
              </p>
              <p className="text-muted-foreground text-xs">{key.lastUsedAt ? `Last used ${formatDay(key.lastUsedAt)}` : "Never used"}</p>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setRevoking(key)}>Revoke</Button>
          </li>
        ))}
        {inbox.keys.length === 0 && <li className="py-2.5 text-muted-foreground text-sm">No keys. Your app needs one to send messages.</li>}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          loading={busy}
          onClick={() => start(async () => {
            onKey((await call("/support/keys/create", { inboxId: inbox.id, name: `Server key ${inbox.keys.length + 1}` })).key);
            reload();
          })}
        >
          <Plus /> New key
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setShowing(true)}>How to add it</Button>
        <span className="flex-1" />
        <Menu>
          <MenuTrigger render={<Button aria-label={`More for ${inbox.name}`} size="icon-sm" variant="ghost" />}><DotsThree weight="bold" /></MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => setRenaming(inbox.name)}>Rename</MenuItem>
            <MenuItem variant="destructive" onClick={() => setConfirming(true)}>Delete support inbox</MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      <Webhook key={inbox.webhook?.url ?? ""} inbox={inbox} reload={reload} />
      <Confirm
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${inbox.name}?`}
        body={`Its keys stop working, and the customer details and status of its ${inbox.conversations} ${inbox.conversations === 1 ? "conversation" : "conversations"} are deleted. The mail stays. This can't be undone.`}
        action="Delete"
        onConfirm={() => run(() => call("/support/inboxes/delete", { id: inbox.id }), "Support inbox deleted").then(reload)}
      />
      <Confirm
        open={revoking !== null}
        onOpenChange={(open) => { if (!open) setRevoking(null); }}
        title={`Revoke ${revoking?.name}?`}
        body="Any app using it can't send messages from now on."
        action="Revoke"
        onConfirm={() => { if (revoking) run(() => call("/support/keys/revoke", { id: revoking.id }), "Key revoked").then(reload); }}
      />
      <Dialog open={renaming !== null} onOpenChange={(open) => { if (!open) setRenaming(null); }}>
        <DialogPopup>
          <Form
            className="contents"
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              void start(async () => {
                await call("/support/inboxes/rename", { id: inbox.id, name: renaming ?? "" });
                setRenaming(null);
                reload();
              });
            }}
          >
            <DialogHeader><DialogTitle>Rename {inbox.name}</DialogTitle></DialogHeader>
            <DialogPanel>
              <Field>
                <FieldLabel>App name</FieldLabel>
                <Input required maxLength={60} value={renaming ?? ""} onChange={(event) => setRenaming(event.target.value)} />
              </Field>
            </DialogPanel>
            <DialogFooter><Button type="submit" loading={busy}>Save</Button></DialogFooter>
          </Form>
        </DialogPopup>
      </Dialog>
      <Dialog open={showing} onOpenChange={setShowing}>
        <DialogPopup className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Add support to your app</DialogTitle>
            <DialogDescription>Use one of this inbox&apos;s keys where it says HELLOBOX_SUPPORT_KEY.</DialogDescription>
          </DialogHeader>
          <DialogPanel><SetupCode apiKey="$HELLOBOX_SUPPORT_KEY" /></DialogPanel>
        </DialogPopup>
      </Dialog>
    </Section>
  );
}

function NewInbox({ mailboxes, first, onCreated, onTab }: {
  mailboxes: Support["mailboxes"]; first: boolean; onCreated: (key: string) => void; onTab: (tab: string) => void;
}) {
  const [busy, start] = useRunning();
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);
  const items = mailboxes.map((mailbox) => ({ value: mailbox.id, label: mailbox.address }));
  const mailboxId = items.some((item) => item.value === chosen) ? chosen : (items[0]?.value ?? null);

  if (!mailboxId) {
    return (
      <Section title="Support">
        <Empty className="py-6">
          <EmptyHeader>
            <EmptyMedia variant="icon"><Chats /></EmptyMedia>
            <EmptyTitle>Add a shared mailbox first</EmptyTitle>
            <EmptyDescription>Messages from your app become conversations in a shared mailbox, on a domain that can send.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent className="flex-row justify-center">
            <Button variant="outline" onClick={() => onTab("mailboxes")}>Open Mailboxes</Button>
            <Button variant="outline" onClick={() => onTab("connection")}>Open Domains</Button>
          </EmptyContent>
        </Empty>
      </Section>
    );
  }
  return (
    <Section
      title={first ? "Add support to your app" : "Another support inbox"}
      description={first ? "Every message your customers send becomes a conversation you answer from HelloBox, by email." : "One for each app, or each team that answers."}
    >
      <Form
        className="space-y-4"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          void start(async () => {
            const inbox = await call("/support/inboxes/create", { mailboxId, name });
            setName("");
            onCreated((await call("/support/keys/create", { inboxId: inbox.id, name: "Server key 1" })).key);
          });
        }}
      >
        <Field>
          <FieldLabel>App name</FieldLabel>
          <Input required maxLength={60} placeholder="Acme" value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field>
          <FieldLabel>Mailbox</FieldLabel>
          <Select value={mailboxId} items={items} onValueChange={setChosen}>
            <SelectTrigger className="w-full sm:w-80" aria-label="Mailbox"><SelectValue /></SelectTrigger>
            <SelectPopup>{items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectPopup>
          </Select>
          <FieldDescription>Replies come from this address.</FieldDescription>
        </Field>
        <Button type="submit" loading={busy}>{first ? "Set up support" : "Add support inbox"}</Button>
      </Form>
    </Section>
  );
}

export function SupportTab({ admin, refresh, onTab }: { admin: boolean; refresh: () => void; onTab: (tab: string) => void }) {
  const [support, setSupport] = useState<Support | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const load = useCallback(
    () => call("/support/inboxes").then((next) => { setSupport(next); setFailed(null); }, (error: unknown) => setFailed(errorMessage(error))),
    [],
  );
  useEffect(() => {
    if (admin) void load();
  }, [admin, load]);
  const reload = useCallback(() => {
    void load();
    refresh();
  }, [load, refresh]);

  if (!admin) {
    return (
      <Section title="Support">
        <p className="text-muted-foreground text-sm">Only workspace admins set up support. Conversations show up in Support for everyone who can read their mailbox.</p>
      </Section>
    );
  }
  if (failed) {
    return (
      <Section title="Support">
        <p className="text-muted-foreground text-sm">{failed}</p>
        <Button className="w-fit" variant="outline" onClick={() => load()}>Try again</Button>
      </Section>
    );
  }
  if (!support) return <Skeleton className="h-64 w-full rounded-2xl" />;
  return (
    <div className="space-y-4">
      {support.inboxes.map((inbox) => <InboxSection key={inbox.id} inbox={inbox} reload={reload} onKey={setNewKey} onTab={onTab} />)}
      <NewInbox
        mailboxes={support.mailboxes}
        first={support.inboxes.length === 0}
        onTab={onTab}
        onCreated={(key) => {
          setNewKey(key);
          reload();
        }}
      />
      <Dialog open={newKey !== null} onOpenChange={(open) => { if (!open) setNewKey(null); }}>
        <DialogPopup className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Your key</DialogTitle>
            <DialogDescription>Copy it now: you won&apos;t see it again. Keep it on your server, as HELLOBOX_SUPPORT_KEY, and never in a browser.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-5">
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-lg bg-muted p-2 font-mono text-xs">{newKey}</code>
              {newKey && <CopyButton value={newKey} />}
            </div>
            {newKey && <SetupCode apiKey={newKey} />}
          </DialogPanel>
          <DialogFooter>
            <Button onClick={() => setNewKey(null)}>Done</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
