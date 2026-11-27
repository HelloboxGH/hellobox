"use client";

import { DotsThree, LockSimple, LockSimpleOpen, Trash } from "@phosphor-icons/react";
import { type FormEvent, useEffect, useState } from "react";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { type Bootstrap, call } from "@/core/client/api";
import { BounceChoice } from "../bounce-choice";
import { Section, useRun } from "../shared";

export function MailboxesTab({ data, refresh }: { data: Bootstrap; refresh: () => void }) {
  const run = useRun();
  const [address, setAddress] = useState("");
  const admin = data.role !== "member";
  const [people, setPeople] = useState<{ userId: string; name: string; email: string }[]>([]);
  const [makingPersonal, setMakingPersonal] = useState<{ id: string; address: string; userId: string } | null>(null);
  useEffect(() => {
    if (admin) call("/members/list").then((team) => setPeople(team.members)).catch(() => undefined);
  }, [admin]);
  return (
    <div className="space-y-4">
      <Section title="Mailboxes" description="Only the addresses you add here receive mail. Mail to any other address at your domains goes to Spam and is deleted after 24 hours. A personal mailbox is read by one person only, admins included.">
        <ul className="divide-y">
          {(admin ? data.managedMailboxes : data.mailboxes.map((mailbox) => ({ ...mailbox, personalUserId: mailbox.personalUserId ?? null }))).map((mailbox) => {
            const mine = mailbox.personalUserId === data.user.id;
            const ownerName = mailbox.personalUserId && (mine ? "you" : people.find((person) => person.userId === mailbox.personalUserId)?.name);
            return (
              <li key={mailbox.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <span className="flex min-w-40 flex-1 flex-wrap items-center gap-2 break-all text-foreground">
                  {mailbox.address}
                  {mailbox.personalUserId && (
                    <Badge variant="secondary" className="gap-1"><LockSimple weight="fill" /> Personal{ownerName ? ` · ${ownerName}` : ""}</Badge>
                  )}
                </span>
                {admin ? (
                  <Input
                    key={mailbox.displayName}
                    className="w-full sm:w-52"
                    maxLength={100}
                    aria-label={`Sender name for ${mailbox.address}`}
                    placeholder="Sender name"
                    defaultValue={mailbox.displayName ?? ""}
                    onBlur={async (event) => {
                      const displayName = event.target.value.trim() || null;
                      if (displayName === mailbox.displayName) return;
                      await run(() => call("/mailboxes/update", { id: mailbox.id, displayName }), "Sender name saved");
                      refresh();
                    }}
                  />
                ) : (
                  mailbox.displayName && <span className="text-muted-foreground">{mailbox.displayName}</span>
                )}
                {((admin && !mailbox.personalUserId && data.entitlements.features.team) || mine) ? (
                  <Menu>
                    <MenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label={`More for ${mailbox.address}`} />}><DotsThree weight="bold" /></MenuTrigger>
                    <MenuPopup align="end">
                      {mine ? (
                        <MenuItem onClick={async () => { if (await run(() => call("/mailboxes/set-personal", { id: mailbox.id, userId: null }), "Mailbox shared")) refresh(); }}>
                          <LockSimpleOpen /> Make shared
                        </MenuItem>
                      ) : (
                        <MenuItem onClick={() => setMakingPersonal({ id: mailbox.id, address: mailbox.address, userId: "" })}>
                          <LockSimple /> Make personal…
                        </MenuItem>
                      )}
                    </MenuPopup>
                  </Menu>
                ) : admin && <span aria-hidden className="size-8" />}
                {admin && <DeleteMailboxButton mailbox={mailbox} refresh={refresh} />}
              </li>
            );
          })}
        </ul>
        {admin && (
          <Form
            className="flex gap-2"
            onSubmit={async (event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              const done = await run(() => call("/mailboxes/create", { address }), "Mailbox added");
              if (done) { setAddress(""); refresh(); }
            }}
          >
            <Input type="email" required aria-label="Mailbox address" placeholder="hello@yourdomain.com" value={address} onChange={(e) => setAddress(e.target.value)} />
            <Button type="submit" variant="outline">Add</Button>
          </Form>
        )}
      </Section>

      <Section
        title="Mail to addresses that don't exist"
        description={admin ? "Whether HelloBox tells the sender when they write to an address with no mailbox." : "Whether HelloBox tells the sender when they write to an address with no mailbox. Only workspace admins can change this."}
      >
        <BounceChoice
          enabled={data.workspace.bouncesEnabled}
          refusesAtDelivery={data.domains.some((domain) => domain.receiveWithHellobox && !domain.removedAt)}
          disabled={!admin}
          onChange={async (enabled) => {
            if (await run(() => call("/workspace/bounces", { enabled }), enabled ? "Bounces turned on" : "Bounces turned off")) refresh();
          }}
        />
      </Section>

      <Dialog open={makingPersonal !== null} onOpenChange={(open) => { if (!open) setMakingPersonal(null); }}>
        <DialogPopup className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Make {makingPersonal?.address} personal</DialogTitle>
            <DialogDescription>
              Only the person you choose will read it. Everyone else loses access, admins and you included, and only they can share it again.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Field>
              <FieldLabel>Belongs to</FieldLabel>
              <Select
                value={makingPersonal?.userId ?? ""}
                onValueChange={(userId) => setMakingPersonal((current) => current && { ...current, userId: String(userId ?? "") })}
                items={people.map((person) => ({ label: person.userId === data.user.id ? `${person.name} (you)` : person.name, value: person.userId }))}
              >
                <SelectTrigger aria-label="Belongs to"><SelectValue placeholder="Choose a person" /></SelectTrigger>
                <SelectPopup>
                  {people.map((person) => (
                    <SelectItem key={person.userId} value={person.userId}>
                      <span className="grid">
                        <span>{person.userId === data.user.id ? `${person.name} (you)` : person.name}</span>
                        <span className="text-muted-foreground text-xs">{person.email}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
          </DialogPanel>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setMakingPersonal(null)}>Cancel</Button>
            <Button
              disabled={!makingPersonal?.userId}
              onClick={async () => {
                if (!makingPersonal?.userId) return;
                const { id, userId } = makingPersonal;
                if (await run(() => call("/mailboxes/set-personal", { id, userId }), "Mailbox is now personal")) {
                  setMakingPersonal(null);
                  refresh();
                }
              }}
            >
              <LockSimple /> Make personal
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

function DeleteMailboxButton({ mailbox, refresh }: { mailbox: { id: string; address: string; personalUserId: string | null }; refresh: () => void }) {
  const run = useRun();
  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button size="icon-sm" variant="ghost" aria-label={`Delete ${mailbox.address}`} title="Delete mailbox" />}>
        <Trash />
      </AlertDialogTrigger>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {mailbox.address}?</AlertDialogTitle>
          <AlertDialogDescription render={<div />} className="space-y-2">
            <p>It leaves the sidebar and the From list, and nobody can send from it.</p>
            <p>
              Its conversations aren&apos;t deleted: {mailbox.personalUserId ? "its owner" : "whoever could read them"} still finds them under All mail and in search. New mail to this address is treated like mail to an address with no mailbox: it goes to Spam and is deleted after 24 hours.
            </p>
            <p>Add the address again to bring the mailbox back.</p>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>Keep mailbox</AlertDialogClose>
          <AlertDialogClose
            render={<Button variant="destructive" />}
            onClick={async () => {
              if (await run(() => call("/mailboxes/delete", { id: mailbox.id }), `${mailbox.address} deleted`)) refresh();
            }}
          >
            Delete mailbox
          </AlertDialogClose>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
