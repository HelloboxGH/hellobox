"use client";

import { At, Check, Plus } from "@phosphor-icons/react";
import { useState } from "react";
import { BounceChoice } from "@/components/settings/bounce-choice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { type Bootstrap, call } from "@/core/client/api";
import { notifyError } from "@/core/client/notify";

const MAILBOX_NAME = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/;
const SUGGESTED = ["hello", "support", "contact", "billing", "team"];

// Shown once a provider is connected and a domain is on, while the workspace has no
// mailboxes: nothing arrives until there is one, because mail to an address without a
// mailbox goes to Spam. This is where mailboxes and bounces get set up the first time.
export function needsMailboxSetup(data: Bootstrap) {
  return (
    data.role !== "member" &&
    !data.workspace.expiring &&
    data.connections.some((connection) => connection.status === "active") &&
    data.domains.some((domain) => domain.enabled && !domain.removedAt) &&
    data.managedMailboxes.length === 0
  );
}

export function MailboxSetup({ data, onChanged, onDone }: { data: Bootstrap; onChanged: () => void; onDone: () => void }) {
  const domains = data.domains.filter((domain) => domain.enabled && !domain.removedAt);
  const [domainId, setDomainId] = useState(domains[0]?.id ?? "");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const domain = domains.find((item) => item.id === domainId) ?? domains[0];
  const mailboxes = data.managedMailboxes;
  const local = name.trim().toLowerCase().replace(/@.*$/, "");
  const taken = (value: string) => mailboxes.some((mailbox) => mailbox.address === `${value}@${domain?.name}`);

  const add = async (value: string) => {
    if (!domain || !MAILBOX_NAME.test(value) || taken(value) || busy) return;
    setBusy(true);
    try {
      await call("/mailboxes/create", { address: `${value}@${domain.name}` });
      setName("");
      onChanged();
    } catch (error) {
      notifyError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Set up mailboxes" className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl space-y-8 px-5 py-10 sm:py-14">
        <header className="space-y-3">
          {/* The step they just finished, so this reads as what comes next, not a new task. */}
          <p className="flex items-center gap-2 text-muted-foreground text-xs">
            <span aria-hidden className="size-1.5 rounded-full bg-success" />
            {domains.length > 1 ? `${domains.length} domains connected` : `${domain?.name} is connected`}
          </p>
          <h1 className="font-semibold text-2xl text-foreground tracking-tight">Choose your mailboxes</h1>
          <p className="max-w-prose text-muted-foreground text-sm">
            Only the addresses you create receive mail. Anything sent to another address at your domain goes to Spam and is
            deleted after 24 hours.
          </p>
        </header>

        <div className="space-y-3">
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              add(local);
            }}
          >
            <div className="flex min-w-0 flex-[1_1_18rem] items-center gap-1.5">
              <Input aria-label="Mailbox name" placeholder="support" autoFocus maxLength={64} value={name} onChange={(event) => setName(event.target.value)} className="min-w-0 flex-1" />
              <At className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              {domains.length > 1 ? (
                <Select value={domain?.id} onValueChange={(value) => value && setDomainId(String(value))} items={domains.map((item) => ({ label: item.name, value: item.id }))}>
                  <SelectTrigger aria-label="Domain" className="w-auto min-w-0 max-w-48"><SelectValue /></SelectTrigger>
                  <SelectPopup>{domains.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectPopup>
                </Select>
              ) : (
                <span className="min-w-0 truncate text-foreground text-sm">{domain?.name}</span>
              )}
            </div>
            <Button type="submit" variant="outline" loading={busy} disabled={!MAILBOX_NAME.test(local) || taken(local)}><Plus /> Add mailbox</Button>
          </form>

          {mailboxes.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5" aria-label="Your mailboxes">
              {mailboxes.map((mailbox) => (
                <li key={mailbox.id} className="flex items-center gap-1.5 rounded-full bg-brand-soft py-1 ps-2 pe-3 text-brand-foreground text-sm">
                  <Check className="size-3.5" weight="bold" /> {mailbox.address}
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex flex-wrap items-center gap-1 text-muted-foreground text-xs">
              <span className="me-1">Common ones:</span>
              {SUGGESTED.map((value) => (
                <Button key={value} type="button" size="xs" variant="ghost" disabled={busy} onClick={() => add(value)}><Plus /> {value}</Button>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-3 border-t pt-8">
          <div className="space-y-1">
            <h2 className="font-medium text-foreground text-sm">When someone writes to an address that doesn&apos;t exist</h2>
            <p className="text-muted-foreground text-xs">You can change this any time in Settings, under Mailboxes.</p>
          </div>
          <BounceChoice
            enabled={data.workspace.bouncesEnabled}
            onChange={async (enabled) => {
              try {
                await call("/workspace/bounces", { enabled });
                onChanged();
              } catch (error) {
                notifyError(error);
              }
            }}
          />
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-6">
          {mailboxes.length === 0 && (
            <p className="me-auto text-muted-foreground text-xs">Add at least one mailbox to start receiving mail.</p>
          )}
          <Button variant="ghost" onClick={onDone}>Later</Button>
          <Button disabled={mailboxes.length === 0} onClick={onDone}>Go to inbox</Button>
        </div>
      </div>
    </section>
  );
}
