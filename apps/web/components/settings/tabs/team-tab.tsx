"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";
import { SenderAvatar } from "@/components/mail/sender-avatar";
import { WorkspaceLogoPicker } from "@/components/workspace-logo";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { type Bootstrap, call, clearWorkspaceId } from "@/core/client/api";
import { safeAvatarUrl } from "@/core/avatar";
import { clientExtensions } from "@/core/client/extensions";
import { MailboxPicker } from "../mailbox-picker";
import { Section, useRun } from "../shared";

const { UpgradeHint } = clientExtensions;

function WorkspaceSection({ data, refresh, others, reload }: {
  data: Bootstrap;
  refresh: () => void;
  others: { userId: string; name: string }[];
  reload: () => void;
}) {
  const run = useRun();
  const [name, setName] = useState(data.workspace.name);
  const [transferTo, setTransferTo] = useState<string | null>(null);
  const admin = data.role !== "member";
  const owner = data.role === "owner";
  // The saved workspace is gone from this person's list, so fall back to their first one.
  const leave = () => {
    clearWorkspaceId();
    window.location.href = "/inbox";
  };
  return (
    <Section title="Workspace" description={admin ? "Shown to everyone here when they switch workspaces." : data.workspace.name}>
      {admin && (
        <Form
          className="flex gap-2"
          onSubmit={async (event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            if (await run(() => call("/workspace/rename", { name }), "Workspace renamed")) refresh();
          }}
        >
          <Input required maxLength={80} aria-label="Workspace name" value={name} onChange={(event) => setName(event.target.value)} />
          <Button type="submit" variant="outline" disabled={name.trim() === data.workspace.name}>Save</Button>
        </Form>
      )}
      {admin && <WorkspaceLogoPicker name={data.workspace.name} logo={data.workspace.logo} onChanged={refresh} />}
      <div className="flex flex-wrap gap-2">
        {owner && others.length > 0 && (
          <AlertDialog>
            <AlertDialogTrigger render={<Button size="sm" variant="outline" />}>Transfer ownership</AlertDialogTrigger>
            <AlertDialogPopup>
              <AlertDialogHeader>
                <AlertDialogTitle>Transfer this workspace?</AlertDialogTitle>
                <AlertDialogDescription>The new owner controls billing and can delete the workspace. You become an admin.</AlertDialogDescription>
              </AlertDialogHeader>
              <div className="px-6 pb-4">
                <Select value={transferTo} onValueChange={setTransferTo} items={others.map((person) => ({ label: person.name, value: person.userId }))}>
                  <SelectTrigger aria-label="New owner"><SelectValue placeholder="Choose a teammate" /></SelectTrigger>
                  <SelectPopup>{others.map((person) => <SelectItem key={person.userId} value={person.userId}>{person.name}</SelectItem>)}</SelectPopup>
                </Select>
              </div>
              <AlertDialogFooter>
                <AlertDialogClose render={<Button variant="ghost" />}>Keep ownership</AlertDialogClose>
                <AlertDialogClose
                  render={<Button variant="destructive" disabled={!transferTo} />}
                  onClick={async () => {
                    if (!transferTo) return;
                    if (await run(() => call("/workspace/transfer", { userId: transferTo }), "Ownership transferred")) {
                      refresh();
                      reload();
                    }
                  }}
                >
                  Transfer
                </AlertDialogClose>
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
        )}
        {owner ? (
          <AlertDialog>
            <AlertDialogTrigger render={<Button size="sm" variant="destructive-outline" />}>Delete workspace</AlertDialogTrigger>
            <AlertDialogPopup>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete {data.workspace.name}?</AlertDialogTitle>
                <AlertDialogDescription>All of this workspace&apos;s mail, attachments and settings are permanently deleted for everyone. Your Resend account isn&apos;t affected.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose render={<Button variant="ghost" />}>Keep workspace</AlertDialogClose>
                <AlertDialogClose
                  render={<Button variant="destructive" />}
                  onClick={async () => {
                    if (await run(() => call("/workspace/delete"), "Workspace deleted")) leave();
                  }}
                >
                  Delete workspace
                </AlertDialogClose>
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
        ) : (
          <AlertDialog>
            <AlertDialogTrigger render={<Button size="sm" variant="destructive-outline" />}>Leave workspace</AlertDialogTrigger>
            <AlertDialogPopup>
              <AlertDialogHeader>
                <AlertDialogTitle>Leave {data.workspace.name}?</AlertDialogTitle>
                <AlertDialogDescription>You lose access to its mail until someone invites you again.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose render={<Button variant="ghost" />}>Stay</AlertDialogClose>
                <AlertDialogClose
                  render={<Button variant="destructive" />}
                  onClick={async () => {
                    if (await run(() => call("/workspace/leave"), "You left the workspace")) leave();
                  }}
                >
                  Leave
                </AlertDialogClose>
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
        )}
      </div>
    </Section>
  );
}

const ROLE_OPTIONS = [
  { label: "Member", value: "member" as const },
  { label: "Admin", value: "admin" as const },
];

export function TeamTab({ data, refresh }: { data: Bootstrap; refresh: () => void }) {
  const memberLimit = data.entitlements.limits.members;
  const run = useRun();
  const [team, setTeam] = useState<Awaited<ReturnType<typeof call<"/members/list">>> | null>(null);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"member" | "admin">("member");
  const [editing, setEditing] = useState<{ userId: string; name: string; mailboxIds: string[] } | null>(null);
  const load = useCallback(() => call("/members/list").then(setTeam), []);
  useEffect(() => {
    load();
  }, [load]);
  const admin = data.role !== "member";
  const atLimit = Boolean(team) && (team?.members.length ?? 0) + (team?.invitations.length ?? 0) >= (memberLimit ?? Number.POSITIVE_INFINITY);
  const owner = data.role === "owner";
  // Only shared mailboxes are handed out; personal ones stay with their person.
  const sharedMailboxes = data.managedMailboxes.filter((mailbox) => !mailbox.personalUserId);
  const sharedIds = new Set(sharedMailboxes.map((mailbox) => mailbox.id));
  return (
    <div className="space-y-4">
    <WorkspaceSection
      data={data}
      refresh={refresh}
      reload={load}
      others={(team?.members ?? []).filter((member) => member.userId !== data.user.id)}
    />
    <Section
      title="Team"
      description={!data.entitlements.features.team ? "Inviting teammates needs a paid plan." : memberLimit === null ? undefined : `Up to ${memberLimit} members on your plan.`}
    >
      <ul className="divide-y">
        {team?.members.map((member) => (
          <li key={member.userId} className="flex flex-wrap items-center gap-2 py-2 text-sm">
            <SenderAvatar name={member.name} src={safeAvatarUrl(member.image)} className="size-7" />
            <span className="min-w-0 flex-1 truncate text-foreground">{member.name} <span className="text-muted-foreground">{member.email}</span></span>
            {owner && member.role !== "owner" ? (
              <Select
                value={member.role}
                items={ROLE_OPTIONS}
                onValueChange={async (role) => {
                  if (!role || role === member.role) return;
                  await run(() => call("/members/update", { userId: member.userId, role }), "Role updated");
                  load();
                }}
              >
                <SelectTrigger size="sm" aria-label={`Role for ${member.name}`} className="w-28"><SelectValue /></SelectTrigger>
                <SelectPopup>{ROLE_OPTIONS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectPopup>
              </Select>
            ) : (
              <Badge variant="outline" className="capitalize">{member.role}</Badge>
            )}
            {admin && data.entitlements.features.team && (() => {
              const assigned = member.mailboxIds.filter((id) => sharedIds.has(id));
              return (
                <Button size="sm" variant="outline" onClick={() => setEditing({ userId: member.userId, name: member.userId === data.user.id ? "you" : member.name, mailboxIds: assigned })}>
                  Mailboxes ({assigned.length})
                </Button>
              );
            })()}
            {admin && member.role !== "owner" && (owner || member.role === "member") && (
              <Button size="sm" variant="ghost" onClick={async () => { await run(() => call("/members/update", { userId: member.userId, role: null }), "Removed"); load(); }}>Remove</Button>
            )}
          </li>
        ))}
        {team?.invitations.map((invite) => (
          <li key={invite.id} className="flex items-center gap-2 py-2 text-sm">
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{invite.email}</span>
            <Badge variant="info">Invited</Badge>
            {admin && <Button size="sm" variant="ghost" onClick={async () => { await run(() => call("/members/revoke-invite", { id: invite.id })); load(); }}>Revoke</Button>}
          </li>
        ))}
      </ul>
      {admin && atLimit && UpgradeHint && <UpgradeHint data={data} reason="members" />}
      {admin && !atLimit && (
        <Form
          className="flex gap-2"
          onSubmit={async (event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            const done = await run(() => call("/members/invite", { email, role: inviteRole }), "Invitation sent");
            if (done) { setEmail(""); load(); }
          }}
        >
          <Input type="email" required aria-label="Teammate's email" placeholder="teammate@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          {owner && (
            <Select value={inviteRole} items={ROLE_OPTIONS} onValueChange={(role) => { if (role) setInviteRole(role); }}>
              <SelectTrigger aria-label="Role" className="w-32"><SelectValue /></SelectTrigger>
              <SelectPopup>{ROLE_OPTIONS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectPopup>
            </Select>
          )}
          <Button type="submit">Invite</Button>
        </Form>
      )}
      {admin && data.entitlements.features.team && (
        <p className="text-muted-foreground text-xs">Everyone reads only the mailboxes they&apos;re given, admins and the owner included. Personal mailboxes stay with their person and can&apos;t be handed out.</p>
      )}
      <Dialog open={editing !== null} onOpenChange={(open) => { if (!open) setEditing(null); }}>
        <DialogPopup className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Mailboxes for {editing?.name}</DialogTitle>
            <DialogDescription>{editing?.name === "you" ? "You" : "They"} can read and send from the shared mailboxes you choose.</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <MailboxPicker
              mailboxes={sharedMailboxes}
              selected={editing?.mailboxIds ?? []}
              onChange={(mailboxIds) => setEditing((current) => current && { ...current, mailboxIds })}
            />
          </DialogPanel>
          <DialogFooter>
            <Button
              onClick={async () => {
                if (!editing) return;
                const { userId, mailboxIds } = editing;
                if (await run(() => call("/members/set-mailboxes", { userId, mailboxIds }), "Mailboxes updated")) {
                  setEditing(null);
                  load();
                }
              }}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </Section>
    </div>
  );
}
