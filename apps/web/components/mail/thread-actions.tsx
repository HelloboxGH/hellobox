"use client";

import {
  Archive, CheckCircle, CheckSquare, ClockCountdown, EnvelopeSimple, EnvelopeSimpleOpen, ShieldWarning, Star, Tag,
  Trash, Tray, TrashSimple, Lightning,
} from "@phosphor-icons/react";
import { type ComponentType, type ReactNode, useCallback, useState } from "react";
import {
  AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  ContextMenuCheckboxItem, ContextMenuGroup, ContextMenuGroupLabel, ContextMenuItem, ContextMenuSeparator,
  ContextMenuSub, ContextMenuSubPopup, ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import {
  MenuCheckboxItem, MenuGroup, MenuGroupLabel, MenuItem, MenuSeparator, MenuSub, MenuSubPopup, MenuSubTrigger,
} from "@/components/ui/menu";
import { toastManager } from "@/components/ui/toast";
import { type Bootstrap, call, type ThreadSummary } from "@/core/client/api";
import { notify, notifyError } from "@/core/client/notify";
import { LabelIcon } from "./label-style";
import { CATEGORIES, SNOOZES, type View } from "./types";

type Folder = ThreadSummary["folder"];
type Category = (typeof CATEGORIES)[number];

export type ThreadAction =
  | { kind: "read"; value: boolean }
  | { kind: "star"; value: boolean }
  | { kind: "important"; value: boolean }
  | { kind: "folder"; folder: "inbox" | "archive" | "trash" }
  | { kind: "spam"; value: boolean }
  | { kind: "delete" }
  | { kind: "snooze"; hours: number; label: string }
  | { kind: "label"; labelId: string; applied: boolean }
  | { kind: "category"; category: Category };

const FOLDER_DONE: Record<"inbox" | "archive" | "trash", string> = {
  inbox: "Moved to inbox",
  archive: "Archived",
  trash: "Moved to trash",
};

const count = (n: number) => (n === 1 ? "1 conversation" : `${n} conversations`);

// Leaves the current list: these actions move conversations out of what's shown.
const removes = (action: ThreadAction) =>
  action.kind === "folder" || action.kind === "spam" || action.kind === "delete" || action.kind === "snooze";

export function patchFor(action: ThreadAction): Partial<ThreadSummary> | null {
  if (action.kind === "read") return { unread: !action.value };
  if (action.kind === "star") return { starred: action.value };
  if (action.kind === "important") return { important: action.value };
  if (action.kind === "category") return { category: action.category };
  return null;
}

// Puts each conversation back in the folder it came from.
async function restoreFolders(targets: ThreadSummary[]) {
  const byFolder = new Map<Folder, string[]>();
  for (const thread of targets) byFolder.set(thread.folder, [...(byFolder.get(thread.folder) ?? []), thread.id]);
  await Promise.all(
    [...byFolder].flatMap(([folder, ids]) =>
      Array.from({ length: Math.ceil(ids.length / 100) }, (_, i) =>
        call("/threads/update", { ids: ids.slice(i * 100, i * 100 + 100), folder: folder as "inbox" | "archive" | "spam" | "trash" }),
      ),
    ),
  );
}

function undoToast(title: string, targets: ThreadSummary[], onChanged: () => void, description?: string) {
  const id = toastManager.add({
    title,
    description,
    type: "success",
    timeout: 8_000,
    actionProps: {
      children: "Undo",
      onClick: async () => {
        toastManager.close(id);
        try {
          await restoreFolders(targets);
          onChanged();
        } catch (error) {
          notifyError(error);
        }
      },
    },
  });
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// One call to the server for up to 100 conversations. Returns the senders a spam report touched.
async function apply(action: ThreadAction, ids: string[]): Promise<string[]> {
  switch (action.kind) {
    case "read":
      await call("/threads/update", { ids, read: action.value });
      return [];
    case "star":
      await call("/threads/update", { ids, starred: action.value });
      return [];
    case "important":
      await call("/threads/update", { ids, important: action.value });
      return [];
    case "category":
      await call("/threads/update", { ids, category: action.category });
      return [];
    case "snooze":
      await call("/threads/update", { ids, snoozedUntil: new Date(Date.now() + action.hours * 3_600_000).toISOString() });
      return [];
    case "label":
      await call("/threads/label", { ids, labelId: action.labelId, applied: action.applied });
      return [];
    case "folder":
      await call("/threads/update", { ids, folder: action.folder });
      return [];
    case "spam":
      return (await call("/threads/report-sender", { ids, verdict: action.value ? "spam" : "not_spam" })).senders;
    case "delete":
      await call("/threads/delete", { ids });
      return [];
  }
}

/**
 * Runs an action on one or many conversations. Rows update straight away and the list
 * reloads after; moves offer Undo, and deleting forever asks first.
 */
export function useThreadActions({
  onChanged, onOptimistic,
}: {
  onChanged: () => void;
  onOptimistic: (ids: string[], patch: Partial<ThreadSummary> | "remove") => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState<ThreadSummary[] | null>(null);

  const perform = useCallback(
    async (action: ThreadAction, targets: ThreadSummary[]) => {
      const ids = targets.map((thread) => thread.id);
      const many = ids.length > 1 ? `${count(ids.length)} ` : "";
      const patch = patchFor(action);
      onOptimistic(ids, removes(action) ? "remove" : (patch ?? {}));
      try {
        const senders = new Set<string>();
        // The server takes 100 at a time; "select all" after Load more can be more.
        for (let i = 0; i < ids.length; i += 100) {
          for (const sender of await apply(action, ids.slice(i, i + 100))) senders.add(sender);
        }
        switch (action.kind) {
          case "category":
            notify(`${many ? `${many}moved` : "Moved"} to ${action.category}`);
            break;
          case "snooze":
            notify(`${many}Snoozed until ${action.label.toLowerCase()}`.trim());
            break;
          case "folder":
            undoToast(capitalize(`${many}${FOLDER_DONE[action.folder].toLowerCase()}`), targets, onChanged);
            break;
          case "spam": {
            const [sender] = senders;
            if (!action.value) {
              notify(`${many ? `${many}moved` : "Moved"} to inbox`, senders.size === 1 ? `${sender} is now allowed.` : "Their senders are now allowed.");
            } else if (targets.length === 1 && sender) {
              // Blocking is a separate choice: one bad message shouldn't silence someone for good.
              const id = toastManager.add({
                title: "Moved to spam",
                description: `Block ${sender} to send their future mail straight to Spam.`,
                type: "success",
                timeout: 10_000,
                actionProps: {
                  children: "Block sender",
                  onClick: async () => {
                    toastManager.close(id);
                    try {
                      await call("/threads/block-sender", { threadId: ids[0] });
                      notify(`${sender} blocked`, "Undo this in Settings, under Rules.");
                    } catch (error) {
                      notifyError(error);
                    }
                  },
                },
              });
            } else {
              undoToast(capitalize(`${many}moved to spam`), targets, onChanged);
            }
            break;
          }
          case "delete":
            notify(`${many ? `${many}deleted` : "Deleted"} forever`);
            break;
        }
      } catch (error) {
        notifyError(error);
      } finally {
        onChanged();
      }
    },
    [onChanged, onOptimistic],
  );

  const run = useCallback(
    (action: ThreadAction, targets: ThreadSummary[]) => {
      if (!targets.length) return;
      if (action.kind === "delete") setConfirmDelete(targets);
      else void perform(action, targets);
    },
    [perform],
  );

  const dialog = (
    <AlertDialog open={!!confirmDelete} onOpenChange={(open) => !open && setConfirmDelete(null)}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {count(confirmDelete?.length ?? 0)} forever?</AlertDialogTitle>
          <AlertDialogDescription>
            Their messages and attachments are removed for everyone in the workspace. This can&apos;t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>Keep them</AlertDialogClose>
          <Button
            variant="destructive"
            onClick={() => {
              const targets = confirmDelete;
              setConfirmDelete(null);
              if (targets) void perform({ kind: "delete" }, targets);
            }}
          >
            Delete forever
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );

  return { run, dialog };
}

/** What a set of conversations offers, from where they are and what they share. */
export function actionsFor(targets: ThreadSummary[], view: View) {
  const folders = new Set(targets.map((thread) => thread.folder));
  const only = (folder: Folder) => folders.size === 1 && folders.has(folder);
  return {
    anyUnread: targets.some((thread) => thread.unread),
    allStarred: targets.length > 0 && targets.every((thread) => thread.starred),
    allImportant: targets.length > 0 && targets.every((thread) => thread.important),
    inSpam: only("spam") || view === "spam",
    inTrash: only("trash") || view === "trash",
    canArchive: !folders.has("archive") || folders.size > 1,
    outOfInbox: !only("inbox"),
  };
}

type Kit = {
  Item: ComponentType<{ onClick?: () => void; variant?: "default" | "destructive"; disabled?: boolean; className?: string; children: ReactNode }>;
  CheckboxItem: ComponentType<{ checked: boolean; onCheckedChange: (checked: boolean) => void; children: ReactNode }>;
  Separator: ComponentType;
  Group: ComponentType<{ children: ReactNode }>;
  GroupLabel: ComponentType<{ children: ReactNode }>;
  Sub: ComponentType<{ children: ReactNode }>;
  SubTrigger: ComponentType<{ children: ReactNode }>;
  SubPopup: ComponentType<{ children: ReactNode }>;
};

export const MENU_KIT: Kit = {
  Item: MenuItem, CheckboxItem: MenuCheckboxItem, Separator: MenuSeparator, Group: MenuGroup,
  GroupLabel: MenuGroupLabel, Sub: MenuSub, SubTrigger: MenuSubTrigger, SubPopup: MenuSubPopup,
};

export const CONTEXT_KIT: Kit = {
  Item: ContextMenuItem, CheckboxItem: ContextMenuCheckboxItem, Separator: ContextMenuSeparator,
  Group: ContextMenuGroup, GroupLabel: ContextMenuGroupLabel, Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger, SubPopup: ContextMenuSubPopup,
};

/**
 * The full list of actions, for the right-click menu and the selection bar's More menu.
 * `compact` leaves out what the selection bar already shows as buttons.
 */
export function ThreadActionItems({
  kit: K, targets, view, labels, run, compact = false, onSelect,
}: {
  kit: Kit;
  targets: ThreadSummary[];
  view: View;
  labels: Bootstrap["labels"];
  run: (action: ThreadAction, targets: ThreadSummary[]) => void;
  compact?: boolean;
  onSelect?: () => void;
}) {
  const state = actionsFor(targets, view);
  const act = (action: ThreadAction) => () => run(action, targets);
  return (
    <>
      {!compact && (
        <>
          {onSelect && <K.Item onClick={onSelect}><CheckSquare /> Select</K.Item>}
          <K.Item onClick={act({ kind: "read", value: state.anyUnread })}>
            {state.anyUnread ? <><EnvelopeSimpleOpen /> Mark as read</> : <><EnvelopeSimple /> Mark as unread</>}
          </K.Item>
          <K.Item onClick={act({ kind: "star", value: !state.allStarred })}>
            <Star /> {state.allStarred ? "Remove star" : "Star"}
          </K.Item>
        </>
      )}
      <K.Item onClick={act({ kind: "important", value: !state.allImportant })}>
        <Lightning /> {state.allImportant ? "Not important" : "Mark important"}
      </K.Item>
      <K.Separator />
      {!compact && (
        <>
          {state.canArchive && <K.Item onClick={act({ kind: "folder", folder: "archive" })}><Archive /> Archive</K.Item>}
          {state.outOfInbox && !state.inSpam && <K.Item onClick={act({ kind: "folder", folder: "inbox" })}><Tray /> Restore</K.Item>}
          {state.inSpam
            ? <K.Item onClick={act({ kind: "spam", value: false })}><CheckCircle /> Not spam</K.Item>
            : <K.Item onClick={act({ kind: "spam", value: true })}><ShieldWarning /> Report spam</K.Item>}
        </>
      )}
      <K.Sub>
        <K.SubTrigger><ClockCountdown /> Snooze</K.SubTrigger>
        <K.SubPopup>
          {SNOOZES.map((item) => (
            <K.Item key={item.label} onClick={act({ kind: "snooze", hours: item.hours, label: item.label })}>{item.label}</K.Item>
          ))}
        </K.SubPopup>
      </K.Sub>
      <K.Sub>
        <K.SubTrigger><Tag /> Label</K.SubTrigger>
        <K.SubPopup>
          {labels.length === 0 && <K.Item disabled>Create a label in the sidebar</K.Item>}
          {labels.map((label) => {
            const applied = targets.every((thread) => thread.labels.some((l) => l.id === label.id));
            return (
              <K.CheckboxItem
                key={label.id}
                checked={applied}
                onCheckedChange={() => run({ kind: "label", labelId: label.id, applied: !applied }, targets)}
              >
                <span className="flex items-center gap-2"><LabelIcon label={label} /> {label.name}</span>
              </K.CheckboxItem>
            );
          })}
        </K.SubPopup>
      </K.Sub>
      <K.Sub>
        <K.SubTrigger><Tray /> Move to category</K.SubTrigger>
        <K.SubPopup>
          {CATEGORIES.map((category) => (
            <K.Item key={category} className="capitalize" onClick={act({ kind: "category", category })}>{category}</K.Item>
          ))}
        </K.SubPopup>
      </K.Sub>
      {!compact && (
        <>
          <K.Separator />
          {state.inTrash
            ? <K.Item variant="destructive" onClick={act({ kind: "delete" })}><TrashSimple /> Delete forever</K.Item>
            : <K.Item variant="destructive" onClick={act({ kind: "folder", folder: "trash" })}><Trash /> Move to trash</K.Item>}
        </>
      )}
    </>
  );
}
