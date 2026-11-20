"use client";

import { WorkspaceMark } from "@/components/workspace-logo";
import {
  AddressBook, Archive, CaretDown, CaretUpDown, ChatCircleText, CodeBlock, ClockCountdown, Desktop, EnvelopeSimple, FileText, Gear, Lightning, LockSimple,
  MagnifyingGlass, Megaphone, Moon, Palette, PaperPlaneTilt, PencilSimple, Plus, ShieldWarning, ShoppingBag, SignOut, Star, Sun,
  Timer, Tray, Trash, UserCircle, UsersThree, DotsThree,
  BellRinging,
} from "@phosphor-icons/react";
import Link from "next/link";
import { type ComponentProps, type FormEvent, type ReactNode, useRef, useState } from "react";
import { Logo } from "@/components/brand";
import { FeedbackDialog } from "@/components/feedback";
import { type Accent, ACCENTS, setAccent, setTheme, type ThemeMode, useAccent, useTheme } from "@/components/theme";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import {
  Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuLinkItem, MenuPopup, MenuRadioGroup, MenuRadioItem,
  MenuSeparator, MenuSub, MenuSubPopup, MenuSubTrigger, MenuTrigger,
} from "@/components/ui/menu";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupAction, SidebarGroupContent,
  SidebarGroupLabel, SidebarHeader, SidebarInput, SidebarMenu, SidebarMenuAction, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { type Bootstrap, call, setWorkspaceId, type ThreadSummary } from "@/core/client/api";
import { authClient } from "@/core/client/auth-client";
import { clientExtensions } from "@/core/client/extensions";
import { notifyError } from "@/core/client/notify";
import { cn } from "@/lib/utils";
import { SenderAvatar } from "./sender-avatar";
import { LabelDialog } from "./label-dialog";
import { LabelIcon } from "./label-style";
import type { ThreadAction } from "./thread-actions";
import { useDropTarget } from "./thread-drag";

const MAILBOXES_OPEN_KEY = "hellobox.sidebar.mailboxes";
// Below this, a search box is more clutter than help.
const SEARCH_FROM = 6;

function readOpen() {
  try {
    return localStorage.getItem(MAILBOXES_OPEN_KEY) !== "closed";
  } catch {
    return true;
  }
}

// Collapsible, and searchable once there are enough mailboxes. While collapsed, the
// selected mailbox stays visible so you can see what the inbox is filtered to.
function MailboxGroup({ mailboxes, activeId, onSelect }: {
  mailboxes: Bootstrap["mailboxes"];
  activeId?: string;
  onSelect: (mailboxId: string | undefined) => void;
}) {
  const [open, setOpen] = useState(readOpen);
  const [query, setQuery] = useState("");
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(MAILBOXES_OPEN_KEY, next ? "open" : "closed");
    } catch {
      // Storage can be blocked; it then just opens next time.
    }
  };
  const needle = query.trim().toLowerCase();
  const matches = needle ? mailboxes.filter((mailbox) => mailbox.address.toLowerCase().includes(needle)) : mailboxes;
  const shown = open ? matches : mailboxes.filter((mailbox) => mailbox.id === activeId);
  return (
    <SidebarGroup>
      <SidebarGroupLabel render={<button type="button" onClick={toggle} aria-expanded={open} />} className="w-full cursor-pointer justify-between hover:text-foreground">
        <span>Mailboxes <span className="text-muted-foreground tabular-nums">{mailboxes.length}</span></span>
        <CaretDown className={cn("transition-transform", !open && "-rotate-90")} />
      </SidebarGroupLabel>
      <SidebarGroupContent>
        {open && mailboxes.length >= SEARCH_FROM && (
          <div className="relative mb-1 px-0.5">
            <MagnifyingGlass aria-hidden className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <SidebarInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Escape") setQuery(""); }}
              placeholder="Find a mailbox"
              aria-label="Find a mailbox"
              className="ps-7"
            />
          </div>
        )}
        <SidebarMenu>
          {open && !needle && (
            <SidebarMenuItem>
              <SidebarMenuButton className={ACTIVE} isActive={!activeId} onClick={() => onSelect(undefined)}>
                <EnvelopeSimple /> <span>All mailboxes</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          {shown.map((mailbox) => (
            <SidebarMenuItem key={mailbox.id}>
              <SidebarMenuButton className={ACTIVE} isActive={activeId === mailbox.id} onClick={() => onSelect(mailbox.id)}>
                {mailbox.personalUserId ? <LockSimple aria-label="Personal" /> : <EnvelopeSimple />} <span className="truncate">{mailbox.address}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
          {open && needle && matches.length === 0 && (
            <p className="px-2 py-1.5 text-muted-foreground text-xs">No mailbox matches &ldquo;{query.trim()}&rdquo;</p>
          )}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
import { NotificationsBell } from "./notifications-menu";
import type { MailFilter, View } from "./types";

const PRIMARY: { view: View; label: string; icon: ReactNode }[] = [
  { view: "inbox", label: "Inbox", icon: <Tray /> },
  { view: "starred", label: "Starred", icon: <Star /> },
  { view: "snoozed", label: "Snoozed", icon: <ClockCountdown /> },
  { view: "sent", label: "Sent", icon: <PaperPlaneTilt /> },
  { view: "drafts", label: "Drafts", icon: <FileText /> },
  { view: "scheduled", label: "Scheduled", icon: <Timer /> },
];
// Who has what. Only on paid plans, where conversations can be assigned.
const TEAM: { view: View; label: string; icon: ReactNode }[] = [
  { view: "assigned", label: "Assigned to me", icon: <UserCircle /> },
  { view: "unassigned", label: "Unassigned", icon: <UsersThree /> },
];
const { AccountMenuItems, HomeMenuItem } = clientExtensions;

const SORTED: { view: View; label: string; icon: ReactNode }[] = [
  { view: "purchases", label: "Purchases", icon: <ShoppingBag /> },
  { view: "important", label: "Important", icon: <Lightning /> },
  { view: "all", label: "All mail", icon: <EnvelopeSimple /> },
  { view: "archive", label: "Archive", icon: <Archive /> },
  { view: "spam", label: "Spam", icon: <ShieldWarning /> },
  { view: "trash", label: "Trash", icon: <Trash /> },
];

type Drop = { action: (targets: ThreadSummary[]) => ThreadAction | null; done?: (count: string) => string };

const all = (targets: ThreadSummary[], test: (thread: ThreadSummary) => boolean) => targets.every(test);

// What dropping conversations on a view does. Views without an entry don't take drops.
const VIEW_DROPS: Partial<Record<View, Drop>> = {
  inbox: {
    action: (targets) =>
      all(targets, (t) => t.folder === "inbox") ? null
        : all(targets, (t) => t.folder === "spam") ? { kind: "spam", value: false }
          : { kind: "folder", folder: "inbox" },
  },
  starred: {
    action: (targets) => (all(targets, (t) => t.starred) ? null : { kind: "star", value: true }),
    done: (count) => `${count} starred`,
  },
  important: {
    action: (targets) => (all(targets, (t) => t.important) ? null : { kind: "important", value: true }),
    done: (count) => `${count} marked important`,
  },
  purchases: {
    action: (targets) => (all(targets, (t) => t.category === "purchases") ? null : { kind: "category", category: "purchases" }),
  },
  archive: { action: (targets) => (all(targets, (t) => t.folder === "archive") ? null : { kind: "folder", folder: "archive" }) },
  spam: { action: (targets) => (all(targets, (t) => t.folder === "spam") ? null : { kind: "spam", value: true }) },
  trash: { action: (targets) => (all(targets, (t) => t.folder === "trash") ? null : { kind: "folder", folder: "trash" }) },
};

const labelDrop = (label: { id: string; name: string }): Drop => ({
  action: (targets) =>
    all(targets, (t) => t.labels.some((l) => l.id === label.id)) ? null : { kind: "label", labelId: label.id, applied: true },
  done: (count) => `${count} labeled ${label.name}`,
});

const NO_DROP: Drop = { action: () => null };

// A sidebar item that conversations can be dragged onto.
function DropMenuButton({ drop = NO_DROP, ...props }: { drop?: Drop } & ComponentProps<typeof SidebarMenuButton>) {
  const target = useDropTarget(drop.action, drop.done);
  return <SidebarMenuButton {...props} {...target.props} />;
}

const ACTIVE = "data-[active=true]:bg-brand-soft data-[active=true]:text-brand-foreground data-[active=true]:font-medium";

export function MailSidebar({
  data, filter, onFilter, onCompose, onRefresh, onOpenThread,
}: {
  data: Bootstrap;
  filter: MailFilter;
  onFilter: (filter: MailFilter) => void;
  onCompose: () => void;
  onRefresh: () => void;
  onOpenThread: (threadId: string) => void;
}) {
  const { setOpenMobile } = useSidebar();
  const footerRow = useRef<HTMLLIElement>(null);
  const theme = useTheme();
  const accent = useAccent();
  const [labelOpen, setLabelOpen] = useState(false);
  const [labelEditing, setLabelEditing] = useState<Bootstrap["labels"][number] | null>(null);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [labelToDelete, setLabelToDelete] = useState<{ id: string; name: string } | null>(null);

  const counts: Partial<Record<View, number>> = {
    inbox: data.counts.inboxUnread,
    spam: data.counts.spam,
    starred: data.counts.starred,
    assigned: data.counts.assigned,
    unassigned: data.counts.unassigned,
  };
  const go = (next: MailFilter) => {
    onFilter(next);
    setOpenMobile(false);
  };
  const views = (items: typeof PRIMARY) => (
    <SidebarMenu>
      {items.map((item) => (
        <SidebarMenuItem key={item.view}>
          <DropMenuButton
            drop={VIEW_DROPS[item.view]}
            className={ACTIVE}
            isActive={filter.view === item.view && !filter.labelId}
            onClick={() => go({ view: item.view, mailboxId: filter.mailboxId })}
          >
            {item.icon}
            <span>{item.label}</span>
          </DropMenuButton>
          {Boolean(counts[item.view]) && (
            <SidebarMenuBadge className="tabular-nums">{counts[item.view]}</SidebarMenuBadge>
          )}
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );

  return (
    <Sidebar>
      <SidebarHeader className="gap-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <Menu>
              <MenuTrigger render={<SidebarMenuButton size="lg" />}>
                {data.workspace.logo ? <WorkspaceMark name={data.workspace.name} logo={data.workspace.logo} /> : <Logo size={32} />}
                <span className="grid min-w-0 flex-1 text-left leading-tight">
                  <span className="truncate font-semibold text-foreground text-sm">{data.workspace.name}</span>
                  {data.entitlements.plan && (
                    <span className="truncate text-muted-foreground text-xs capitalize">{data.entitlements.plan} plan</span>
                  )}
                </span>
                <CaretUpDown className="ms-auto" />
              </MenuTrigger>
              <MenuPopup align="start" className="min-w-56">
                <MenuGroup>
                  <MenuGroupLabel>Workspaces</MenuGroupLabel>
                  {data.workspaces.map((workspace) => (
                    <MenuItem
                      key={workspace.id}
                      onClick={() => {
                        setWorkspaceId(workspace.id);
                        window.location.reload();
                      }}
                    >
                      <WorkspaceMark name={workspace.name} logo={workspace.logo} className="size-5 rounded-md text-[0.5rem]" />
                      <span className="truncate">{workspace.name}</span>
                      {Boolean(workspace.unread) && (
                        <span className="ms-auto ps-3 text-muted-foreground text-xs tabular-nums">
                          <span aria-hidden>{(workspace.unread ?? 0) > 99 ? "99+" : workspace.unread}</span>
                          <span className="sr-only">{workspace.unread} unread</span>
                        </span>
                      )}
                    </MenuItem>
                  ))}
                </MenuGroup>
                <MenuSeparator />
                <MenuItem onClick={() => setWorkspaceOpen(true)}><Plus /> New workspace</MenuItem>
              </MenuPopup>
            </Menu>
          </SidebarMenuItem>
        </SidebarMenu>
        <Button data-tour="compose" onClick={() => { onCompose(); setOpenMobile(false); }} size="lg" className="w-full justify-between">
          <span className="flex items-center gap-2"><PencilSimple weight="bold" /> Compose</span>
          <Kbd className="bg-primary-foreground/15 text-primary-foreground">C</Kbd>
        </Button>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup data-tour="views">
          <SidebarGroupContent>{views(PRIMARY)}</SidebarGroupContent>
        </SidebarGroup>
        {data.entitlements.features.team && (
          <SidebarGroup>
            <SidebarGroupLabel>Team</SidebarGroupLabel>
            <SidebarGroupContent>
              {views(TEAM)}
            </SidebarGroupContent>
          </SidebarGroup>
        )}
        <SidebarGroup data-tour="sorted">
          <SidebarGroupLabel>Sorted</SidebarGroupLabel>
          <SidebarGroupContent>{views(SORTED)}</SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton render={<Link href="/campaigns" />}>
                  <Megaphone /> <span>Campaigns</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton render={<Link href="/contacts" />}>
                  <AddressBook /> <span>Contacts</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton render={<Link href="/templates" />}>
                  <CodeBlock /> <span>Templates</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {data.mailboxes.length > 1 && (
          <MailboxGroup mailboxes={data.mailboxes} activeId={filter.mailboxId} onSelect={(mailboxId) => go({ ...filter, mailboxId })} />
        )}

        <SidebarGroup>
          <SidebarGroupLabel>Labels</SidebarGroupLabel>
          <SidebarGroupAction aria-label="New label" onClick={() => setLabelOpen(true)}><Plus /></SidebarGroupAction>
          <SidebarGroupContent>
            <SidebarMenu>
              {data.labels.map((label) => (
                <SidebarMenuItem key={label.id}>
                  <DropMenuButton
                    drop={labelDrop(label)}
                    className={ACTIVE}
                    isActive={filter.labelId === label.id}
                    onClick={() => go({ view: "all", labelId: label.id, mailboxId: filter.mailboxId })}
                  >
                    <LabelIcon label={label} /> <span>{label.name}</span>
                  </DropMenuButton>
                  <Menu>
                    <MenuTrigger render={<SidebarMenuAction showOnHover aria-label={`${label.name} options`} className="data-popup-open:opacity-100" />}>
                      <DotsThree weight="bold" />
                    </MenuTrigger>
                    <MenuPopup align="start" side="right">
                      <MenuItem onClick={() => setLabelEditing(label)}><PencilSimple /> Edit label</MenuItem>
                      {data.role !== "member" && (
                        <MenuItem variant="destructive" onClick={() => setLabelToDelete(label)}><Trash /> Delete label</MenuItem>
                      )}
                    </MenuPopup>
                  </Menu>
                </SidebarMenuItem>
              ))}
              {data.labels.length === 0 && (
                <SidebarMenuItem>
                  <SidebarMenuButton onClick={() => setLabelOpen(true)}><Plus /> <span>Create a label</span></SidebarMenuButton>
                </SidebarMenuItem>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter data-tour="account">
        <SidebarMenu>
          <SidebarMenuItem ref={footerRow} className="flex items-center gap-1">
            <div className="min-w-0 flex-1">
            <Menu>
              <MenuTrigger render={<SidebarMenuButton size="lg" />}>
                <SenderAvatar name={data.user.name} src={data.user.image} className="size-7" />
                <span className="grid min-w-0 flex-1 text-left leading-tight">
                  <span className="truncate font-medium text-foreground text-sm">{data.user.name}</span>
                  <span className="truncate text-muted-foreground text-xs">{data.user.email}</span>
                </span>
                <CaretUpDown className="ms-auto" />
              </MenuTrigger>
              <MenuPopup align="start" side="top" className="min-w-56">
                <MenuLinkItem render={<Link href="/settings" />}><Gear /> Settings</MenuLinkItem>
                <MenuLinkItem render={<Link href="/settings?tab=notifications" />}><BellRinging /> Notifications</MenuLinkItem>
                <MenuItem onClick={() => setFeedbackOpen(true)}><ChatCircleText /> Send feedback</MenuItem>
                {HomeMenuItem && <HomeMenuItem />}
                <MenuSub>
                  <MenuSubTrigger>
                    {theme === "dark" ? <Moon /> : theme === "light" ? <Sun /> : <Desktop />} Theme
                  </MenuSubTrigger>
                  <MenuSubPopup>
                    <MenuRadioGroup value={theme} onValueChange={(value) => setTheme(value as ThemeMode)}>
                      <MenuRadioItem value="system"><span className="flex items-center gap-2"><Desktop /> System</span></MenuRadioItem>
                      <MenuRadioItem value="light"><span className="flex items-center gap-2"><Sun /> Light</span></MenuRadioItem>
                      <MenuRadioItem value="dark"><span className="flex items-center gap-2"><Moon /> Dark</span></MenuRadioItem>
                    </MenuRadioGroup>
                  </MenuSubPopup>
                </MenuSub>
                <MenuSub>
                  <MenuSubTrigger><Palette /> Accent</MenuSubTrigger>
                  <MenuSubPopup>
                    <MenuRadioGroup value={accent} onValueChange={(value) => setAccent(value as Accent)}>
                      {ACCENTS.map((item) => (
                        <MenuRadioItem key={item.value} value={item.value}>
                          <span className="flex items-center gap-2">
                            <span aria-hidden className="size-3 rounded-full" style={{ backgroundColor: item.color }} /> {item.label}
                          </span>
                        </MenuRadioItem>
                      ))}
                    </MenuRadioGroup>
                  </MenuSubPopup>
                </MenuSub>
                {AccountMenuItems && <AccountMenuItems data={data} />}
                <MenuSeparator />
                <MenuItem
                  onClick={() =>
                    authClient.signOut().then(() => {
                      window.location.href = "/login";
                    })
                  }
                >
                  <SignOut /> Sign out
                </MenuItem>
              </MenuPopup>
            </Menu>
            </div>
            {/* Only paid plans have teammates who can assign anything. */}
            {data.entitlements.features.team && (
              <NotificationsBell
                unread={data.notificationsUnread}
                anchor={footerRow}
                onChanged={onRefresh}
                onOpenThread={(threadId) => {
                  onOpenThread(threadId);
                  setOpenMobile(false);
                }}
              />
            )}
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />

      <Dialog open={workspaceOpen} onOpenChange={setWorkspaceOpen}>
        <DialogPopup className="sm:max-w-sm">
          <Form
            className="contents"
            onSubmit={async (event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              const name = String(new FormData(event.currentTarget).get("name"));
              setWorkspaceOpen(false);
              try {
                const { id } = await call("/workspaces/create", { name });
                setWorkspaceId(id);
                window.location.href = "/inbox";
              } catch (error) {
                notifyError(error);
              }
            }}
          >
            <DialogHeader>
              <DialogTitle>New workspace</DialogTitle>
              <DialogDescription>A separate inbox with its own email provider, team and plan.</DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <Field>
                <FieldLabel>Name</FieldLabel>
                <Input name="name" required autoFocus maxLength={80} placeholder="Acme" />
              </Field>
            </DialogPanel>
            <DialogFooter><Button type="submit">Create workspace</Button></DialogFooter>
          </Form>
        </DialogPopup>
      </Dialog>

      <AlertDialog open={labelToDelete !== null} onOpenChange={(open) => { if (!open) setLabelToDelete(null); }}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {labelToDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>It comes off every conversation for everyone here. The conversations stay.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Keep label</AlertDialogClose>
            <AlertDialogClose
              render={<Button variant="destructive" />}
              onClick={async () => {
                if (!labelToDelete) return;
                try {
                  await call("/labels/delete", { id: labelToDelete.id });
                  if (filter.labelId === labelToDelete.id) go({ view: "inbox" });
                  onRefresh();
                } catch (error) {
                  notifyError(error);
                }
              }}
            >
              Delete label
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      <LabelDialog
        open={labelOpen || labelEditing !== null}
        onOpenChange={(open) => {
          if (open) return;
          setLabelOpen(false);
          setLabelEditing(null);
        }}
        label={labelEditing}
        onSaved={onRefresh}
      />
    </Sidebar>
  );
}
