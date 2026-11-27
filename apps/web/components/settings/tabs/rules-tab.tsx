"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { call } from "@/core/client/api";
import { Section, useRun } from "../shared";
import { CATEGORIES } from "./suppressions-tab";

// Personal: each person keeps their own list, and it covers the mailboxes they read.
function NeverSpamSection() {
  const run = useRun();
  const [domains, setDomains] = useState<{ domain: string }[] | null>(null);
  const [domain, setDomain] = useState("");
  const load = useCallback(() => call("/account/spam-exemptions").then((result) => setDomains(result.domains)), []);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <Section
      title="Never send to Spam"
      description="Your own list. Mail from these domains and their subdomains stays out of Spam in the mailboxes you read, even when the scanner or other HelloBox users flag it. A sender your workspace blocked still goes to Spam."
    >
      <ul className="divide-y">
        {domains?.map((row) => (
          <li key={row.domain} className="flex items-center gap-2 py-2 text-sm">
            <span className="min-w-0 flex-1 truncate text-foreground">{row.domain}</span>
            <Button size="sm" variant="ghost" onClick={async () => { await run(() => call("/account/spam-exemptions/remove", { domain: row.domain })); load(); }}>Remove</Button>
          </li>
        ))}
        {domains?.length === 0 && <li className="py-2 text-muted-foreground text-sm">No domains yet.</li>}
      </ul>
      <Form
        className="flex flex-wrap gap-2"
        onSubmit={async (event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const done = await run(() => call("/account/spam-exemptions/add", { domain }));
          if (done) { setDomain(""); load(); }
        }}
      >
        <Input className="min-w-44 flex-1" required aria-label="Domain to keep out of Spam" placeholder="example.com" value={domain} onChange={(e) => setDomain(e.target.value)} />
        <Button type="submit" variant="outline">Add domain</Button>
      </Form>
    </Section>
  );
}

export function RulesTab({ admin }: { admin: boolean }) {
  const run = useRun();
  const [state, setState] = useState<Awaited<ReturnType<typeof call<"/rules/list">>> | null>(null);
  const [domain, setDomain] = useState("");
  const [blockValue, setBlockValue] = useState("");
  const [sendersOpen, setSendersOpen] = useState(false);
  // A personal mail provider's domain waits here for a second yes.
  const [confirmCommon, setConfirmCommon] = useState<string | null>(null);
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]["value"]>("notifications");
  const load = useCallback(() => call("/rules/list").then(setState), []);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <div className="space-y-4">
      <Section title="Rules" description="The first matching rule wins, and rules beat automatic sorting.">
        <ul className="divide-y">
          {state?.rules.map((rule) => (
            <li key={rule.id} className="flex items-center gap-2 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate text-foreground">{rule.name}</span>
              {admin && <Button size="sm" variant="ghost" onClick={async () => { await run(() => call("/rules/delete", { id: rule.id })); load(); }}>Delete</Button>}
            </li>
          ))}
        </ul>
        {!admin && <p className="text-muted-foreground text-sm">Only workspace admins can change rules, because they apply to every mailbox.</p>}
        {admin && <Form
          className="flex flex-wrap gap-2"
          onSubmit={async (event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            const done = await run(() =>
              call("/rules/create", {
                name: `${domain} → ${category}`,
                conditions: [{ field: "fromDomain", op: "equals", value: domain }],
                action: { category },
              }),
            );
            if (done) { setDomain(""); load(); }
          }}
        >
          <Input className="min-w-44 flex-1" required aria-label="Sender domain" placeholder="stripe.com" value={domain} onChange={(e) => setDomain(e.target.value)} />
          <Select value={category} onValueChange={(value) => { if (value) setCategory(value); }} items={[...CATEGORIES]}>
            <SelectTrigger aria-label="Category" className="w-full sm:w-44"><SelectValue /></SelectTrigger>
            <SelectPopup>
              {CATEGORIES.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
            </SelectPopup>
          </Select>
          <Button type="submit" variant="outline">Add rule</Button>
        </Form>}
      </Section>
      <Section title="Sender lists" description="Block an address or a whole domain. HelloBox's own mail server refuses their mail, so the sender gets a bounce. Mail that comes through your provider goes to Spam instead.">
        {admin && (
          <>
            <Form
              className="flex flex-wrap gap-2"
              onSubmit={async (event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                let asked: string | null = null;
                const done = await run(async () => {
                  const result = await call("/senders/block", { value: blockValue });
                  if (result.needsConfirmation) asked = result.value;
                });
                if (!done) return;
                if (asked) return setConfirmCommon(asked);
                setBlockValue("");
                load();
              }}
            >
              <Input className="min-w-44 flex-1" required aria-label="Address or domain to block" placeholder="spam@example.com or example.com" value={blockValue} onChange={(e) => { setBlockValue(e.target.value); setConfirmCommon(null); }} />
              <Button type="submit" variant="outline">Block</Button>
            </Form>
            <AlertDialog open={confirmCommon !== null} onOpenChange={(open) => { if (!open) setConfirmCommon(null); }}>
              <AlertDialogPopup>
                <AlertDialogHeader>
                  <AlertDialogTitle>Block everyone at {confirmCommon}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    {confirmCommon} is a personal mail provider used by millions of people, probably including customers and contacts of yours. Blocking the
                    domain refuses mail from all of them. To stop one person, block their address instead.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
                  <Button
                    variant="destructive"
                    onClick={async () => {
                      const done = await run(() => call("/senders/block", { value: confirmCommon ?? "", confirmCommon: true }));
                      if (done) { setConfirmCommon(null); setBlockValue(""); load(); }
                    }}
                  >
                    Block {confirmCommon}
                  </Button>
                </AlertDialogFooter>
              </AlertDialogPopup>
            </AlertDialog>
          </>
        )}
        <Button variant="outline" size="sm" className="self-start" onClick={() => setSendersOpen(true)}>
          Show blocked senders and domains{state ? ` (${state.senders.length})` : ""}
        </Button>
        <Dialog open={sendersOpen} onOpenChange={setSendersOpen}>
          <DialogPopup className="sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>Sender lists</DialogTitle>
              <DialogDescription>Blocked senders and domains come first, then the ones you allowed.</DialogDescription>
            </DialogHeader>
            <DialogPanel className="space-y-3">
        <ul className="divide-y">
          {state?.senders.toSorted((a, b) => Number(b.kind === "blocked") - Number(a.kind === "blocked")).map((sender) => (
            <li key={sender.id} className="flex items-center gap-2 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate text-foreground">{sender.value}</span>
              <Badge variant={sender.kind === "blocked" ? "error" : "secondary"} className="capitalize">{sender.kind.replace("_", " ")}</Badge>
              {admin && <Button size="sm" variant="ghost" onClick={async () => { await run(() => call("/senders/remove", { id: sender.id })); load(); }}>{sender.kind === "blocked" ? "Unblock" : "Remove"}</Button>}
            </li>
          ))}
          {state?.senders.length === 0 && <li className="py-2 text-muted-foreground text-sm">Nothing here yet.</li>}
        </ul>
        
                  </DialogPanel>
          </DialogPopup>
        </Dialog>
        </Section>
      <NeverSpamSection />
    </div>
  );
}
