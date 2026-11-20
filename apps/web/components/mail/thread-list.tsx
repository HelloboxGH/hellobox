"use client";

import {
  Archive, Check, CheckCircle, ClockCountdown, DotsThree, EnvelopeSimple, EnvelopeSimpleOpen, FileText, MagnifyingGlass,
  Paperclip, ShieldCheck, ShieldWarning, Star, Timer, Trash, TrashSimple, Tray, UserCircle, UsersThree, List, X,
} from "@phosphor-icons/react";
import { type ComponentType, type PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { ContextMenu, ContextMenuPopup, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Kbd } from "@/components/ui/kbd";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { useSidebar } from "@/components/ui/sidebar";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { type Bootstrap, call, type Draft, type Scheduled, type ThreadSummary } from "@/core/client/api";
import { useMediaQuery } from "@/hooks/use-media-query";
import { errorMessage, notifyError } from "@/core/client/notify";
import { cn } from "@/lib/utils";
import { IconAction } from "./icon-action";
import { SenderAvatar } from "./sender-avatar";
import { LabelChip } from "./label-style";
import { actionsFor, CONTEXT_KIT, MENU_KIT, ThreadActionItems, useThreadActions } from "./thread-actions";
import { endThreadDrag, startThreadDrag, useThreadDrag } from "./thread-drag";
import { type ComposeState, formatListTime, type MailFilter, VIEW_TITLES, type View } from "./types";

type Category = "primary" | "notifications" | "purchases" | "newsletters";

const NONE = new Set<string>();
const LONG_PRESS_MS = 450;

const EMPTY: Partial<Record<View, { icon: ComponentType; title: string; body: string }>> = {
  inbox: { icon: CheckCircle, title: "You're all caught up", body: "New mail to your domain lands here." },
  starred: { icon: Star, title: "Nothing starred", body: "Star a conversation to keep it close." },
  snoozed: { icon: ClockCountdown, title: "Nothing snoozed", body: "Snoozed mail comes back when you asked it to." },
  assigned: { icon: UserCircle, title: "Nothing assigned to you", body: "Conversations a teammate gives you land here until they're archived." },
  unassigned: { icon: UsersThree, title: "Everything has an owner", body: "New mail in shared mailboxes waits here until someone takes it." },
  drafts: { icon: FileText, title: "No drafts", body: "Unsent messages save here as you type." },
  scheduled: { icon: Timer, title: "Nothing scheduled", body: "Pick a time when you send, and it waits here." },
  spam: { icon: ShieldCheck, title: "No spam", body: "Anything suspicious is held here for 30 days." },
  trash: { icon: Trash, title: "Trash is empty", body: "Deleted conversations stay here for 30 days." },
};

function senderOf(thread: ThreadSummary) {
  const others = thread.participants.filter((p) => p.address !== thread.mailboxAddress);
  const person = others[0] ?? thread.participants[0];
  return person?.name || person?.address || "Unknown sender";
}

function RowSkeleton() {
  return (
    <div className="flex gap-3 px-3 py-2.5">
      <Skeleton className="size-8 shrink-0 rounded-full" />
      <div className="flex-1 space-y-2 py-0.5">
        <Skeleton className="h-3 w-2/5" />
        <Skeleton className="h-3 w-4/5" />
        <Skeleton className="h-3 w-3/5" />
      </div>
    </div>
  );
}

export function ThreadList({
  filter, query, onQuery, selectedId, refreshKey, labels, onSelect, onCompose, onChanged, onThreads,
}: {
  filter: MailFilter;
  query: string;
  onQuery: (query: string) => void;
  selectedId: string | null;
  refreshKey: number;
  labels: Bootstrap["labels"];
  onSelect: (id: string) => void;
  onCompose: (state: Omit<ComposeState, "key">) => void;
  onChanged: () => void;
  onThreads: (ids: string[]) => void;
}) {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [scheduled, setScheduled] = useState<Scheduled[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<Category | undefined>();
  const latest = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 200);
    return () => clearTimeout(timer);
  }, [query]);

  const filterKey = JSON.stringify(filter);
  const loading = loadedFor !== filterKey;
  const isSpecial = filter.view === "drafts" || filter.view === "scheduled";

  const load = useCallback(
    async (nextCursor?: string) => {
      const request = ++latest.current;
      try {
        if (filter.view === "drafts") {
          const rows = await call("/drafts/list");
          if (request === latest.current) setDrafts(rows);
        } else if (filter.view === "scheduled") {
          const rows = await call("/mail/scheduled");
          if (request === latest.current) setScheduled(rows);
        } else {
          const result = await call("/threads/list", {
            view: filter.view === "purchases" ? "all" : filter.view,
            category: filter.view === "purchases" ? "purchases" : filter.view === "inbox" ? category : undefined,
            mailboxId: filter.mailboxId,
            labelId: filter.labelId,
            q: search || undefined,
            cursor: nextCursor,
          });
          if (request !== latest.current) return;
          setThreads((current) => {
            const next = nextCursor ? [...current, ...result.threads] : result.threads;
            onThreads(next.map((thread) => thread.id));
            return next;
          });
          setCursor(result.nextCursor);
        }
        if (request === latest.current) setFailed(null);
      } catch (error) {
        if (request === latest.current) setFailed(errorMessage(error));
      } finally {
        if (request === latest.current) setLoadedFor(JSON.stringify(filter));
      }
    },
    [filter, category, search, onThreads],
  );

  // refreshKey is a dependency so that new mail reloads the list.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    void Promise.resolve().then(() => load());
  }, [load, refreshKey]);

  // Multi-select. The selection belongs to what's listed: changing view, tab or search
  // drops it, and conversations that leave the list leave the selection.
  const scope = `${filterKey}|${category ?? ""}|${search}`;
  const [selection, setSelection] = useState({ scope, ids: NONE });
  const selectedIds = selection.scope === scope ? selection.ids : NONE;
  const picked = useMemo(() => threads.filter((thread) => selectedIds.has(thread.id)), [threads, selectedIds]);
  const selecting = picked.length > 0;
  const anchor = useRef<string | null>(null);
  const [menuFor, setMenuFor] = useState<ThreadSummary[]>([]);
  const [menuRow, setMenuRow] = useState<string | null>(null);
  // Touch screens long-press to select instead of opening a context menu.
  const touch = useMediaQuery({ pointer: "coarse" });
  const { toggleSidebar } = useSidebar();

  const toggle = useCallback(
    (id: string, range = false) => {
      setSelection((current) => {
        const ids = new Set(current.scope === scope ? current.ids : NONE);
        const order = threads.map((thread) => thread.id);
        const from = anchor.current ? order.indexOf(anchor.current) : -1;
        const to = order.indexOf(id);
        if (range && from >= 0 && to >= 0) {
          for (const rowId of order.slice(Math.min(from, to), Math.max(from, to) + 1)) ids.add(rowId);
        } else if (ids.has(id)) {
          ids.delete(id);
        } else {
          ids.add(id);
        }
        anchor.current = id;
        return { scope, ids };
      });
    },
    [scope, threads],
  );
  const clearSelection = useCallback(() => setSelection({ scope, ids: NONE }), [scope]);
  const selectAll = () => setSelection({ scope, ids: new Set(threads.map((thread) => thread.id)) });

  const onOptimistic = useCallback((ids: string[], patch: Partial<ThreadSummary> | "remove") => {
    setThreads((rows) =>
      patch === "remove"
        ? rows.filter((row) => !ids.includes(row.id))
        : rows.map((row) => (ids.includes(row.id) ? { ...row, ...patch } : row)),
    );
  }, []);
  const { run, dialog } = useThreadActions({ onChanged, onOptimistic });
  const bar = actionsFor(picked, filter.view);
  const drag = useThreadDrag();
  const dragging = useMemo(() => new Set(drag?.targets.map((thread) => thread.id)), [drag]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (target.closest("input,textarea,[contenteditable],[role=dialog],[role=menu]")) return;
      if (event.key === "Escape" && selecting) {
        event.stopImmediatePropagation();
        clearSelection();
      } else if (event.key === "x" && selectedId) {
        event.preventDefault();
        toggle(selectedId);
      }
    }
    // Capture, so Escape clears the selection before the reader closes.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [selecting, selectedId, clearSelection, toggle]);

  // Long press on touch: the first selects, then plain taps add or remove.
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const pressed = useRef(false);
  const cancelPress = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };
  const startPress = (event: PointerEvent, id: string) => {
    pressed.current = false;
    if (event.pointerType !== "touch") return;
    cancelPress();
    press.current = {
      x: event.clientX,
      y: event.clientY,
      timer: setTimeout(() => {
        press.current = null;
        pressed.current = true;
        toggle(id);
        navigator.vibrate?.(10);
      }, LONG_PRESS_MS),
    };
  };
  const movePress = (event: PointerEvent) => {
    if (press.current && Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > 10) cancelPress();
  };

  async function toggleStar(thread: ThreadSummary) {
    setThreads((rows) => rows.map((row) => (row.id === thread.id ? { ...row, starred: !row.starred } : row)));
    try {
      await call("/threads/update", { ids: [thread.id], starred: !thread.starred });
      onChanged();
    } catch (error) {
      notifyError(error);
      load();
    }
  }

  const title = VIEW_TITLES[filter.view];
  const isEmpty = !loading && !failed && (
    filter.view === "drafts" ? !drafts.length : filter.view === "scheduled" ? !scheduled.length : !threads.length
  );
  const emptyCopy = search
    ? { icon: MagnifyingGlass, title: `No results for “${search}”`, body: "Try a name, an address or a word from the message." }
    : (EMPTY[filter.view] ?? { icon: Tray, title: `Nothing in ${title.toLowerCase()}`, body: "Conversations will appear here." });
  const EmptyIcon = emptyCopy.icon;

  return (
    <section aria-label={title} className="flex h-full min-h-0 flex-col">
      <header className="space-y-3 p-4 pb-2">
        {selecting ? (
          <div className="-mx-1 flex h-7 items-center gap-0.5" role="toolbar" aria-label="Selected conversations">
            <IconAction label="Clear selection" shortcut="Esc" onClick={clearSelection}><X /></IconAction>
            <span className="ms-1 me-auto font-medium text-foreground text-sm tabular-nums" aria-live="polite">
              {picked.length} selected
            </span>
            {bar.canArchive && !bar.inTrash && !bar.inSpam ? (
              <IconAction label="Archive" onClick={() => run({ kind: "folder", folder: "archive" }, picked)}><Archive /></IconAction>
            ) : (
              <IconAction label="Move to inbox" onClick={() => run(bar.inSpam ? { kind: "spam", value: false } : { kind: "folder", folder: "inbox" }, picked)}><Tray /></IconAction>
            )}
            {!bar.inSpam && (
              <IconAction label="Report spam" onClick={() => run({ kind: "spam", value: true }, picked)}><ShieldWarning /></IconAction>
            )}
            {bar.inTrash ? (
              <IconAction label="Delete forever" onClick={() => run({ kind: "delete" }, picked)}><TrashSimple /></IconAction>
            ) : (
              <IconAction label="Move to trash" onClick={() => run({ kind: "folder", folder: "trash" }, picked)}><Trash /></IconAction>
            )}
            <IconAction
              label={bar.anyUnread ? "Mark as read" : "Mark as unread"}
              onClick={() => run({ kind: "read", value: bar.anyUnread }, picked)}
            >
              {bar.anyUnread ? <EnvelopeSimpleOpen /> : <EnvelopeSimple />}
            </IconAction>
            <IconAction label={bar.allStarred ? "Remove star" : "Star"} onClick={() => run({ kind: "star", value: !bar.allStarred }, picked)}>
              <Star weight={bar.allStarred ? "fill" : "regular"} className={bar.allStarred ? "text-amber-500" : undefined} />
            </IconAction>
            <Menu>
              <MenuTrigger render={<Button aria-label="More actions" size="icon-sm" variant="ghost" />}><DotsThree weight="bold" /></MenuTrigger>
              <MenuPopup align="end">
                {picked.length < threads.length
                  ? <MenuItem onClick={selectAll}>Select all {threads.length}</MenuItem>
                  : <MenuItem onClick={clearSelection}>Select none</MenuItem>}
                <MenuSeparator />
                <ThreadActionItems kit={MENU_KIT} targets={picked} view={filter.view} labels={labels} run={run} compact />
              </MenuPopup>
            </Menu>
          </div>
        ) : (
          <div className="flex h-7 items-center gap-2">
            <Button variant="ghost" size="icon-sm" aria-label="Open menu" className="-ms-1 md:hidden" onClick={toggleSidebar}>
              <List className="size-5" />
            </Button>
            <h1 className="font-heading font-semibold text-foreground text-lg tracking-tight">{title}</h1>
          </div>
        )}
        {!isSpecial && (
          <InputGroup data-tour="search">
            <InputGroupAddon><MagnifyingGlass aria-hidden="true" /></InputGroupAddon>
            <InputGroupInput
              id="mail-search"
              aria-label="Search mail"
              placeholder="Search mail"
              type="search"
              value={query}
              onChange={(event) => onQuery(event.target.value)}
            />
            <InputGroupAddon align="inline-end">
              {query ? (
                <Button aria-label="Clear search" onClick={() => onQuery("")} size="icon-xs" variant="ghost"><X /></Button>
              ) : (
                <Kbd className="hidden sm:inline-flex">/</Kbd>
              )}
            </InputGroupAddon>
          </InputGroup>
        )}
        {filter.view === "inbox" && (
          <Tabs value={category ?? "all"} onValueChange={(value) => setCategory(value === "all" ? undefined : (value as Category))}>
            <TabsList className="w-full" aria-label="Filter by category">
              <TabsTab value="all">All</TabsTab>
              <TabsTab value="primary">Primary</TabsTab>
              <TabsTab value="notifications">Alerts</TabsTab>
              <TabsTab value="newsletters">News</TabsTab>
            </TabsList>
          </Tabs>
        )}
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="px-2 pb-2">
          {loading && Array.from({ length: 7 }, (_, index) => <RowSkeleton key={index} />)}
          {failed && (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>We couldn&apos;t load this</EmptyTitle>
                <EmptyDescription>{failed}</EmptyDescription>
              </EmptyHeader>
              <EmptyContent><Button variant="outline" onClick={() => load()}>Try again</Button></EmptyContent>
            </Empty>
          )}
          {isEmpty && (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon"><EmptyIcon /></EmptyMedia>
                <EmptyTitle>{emptyCopy.title}</EmptyTitle>
                <EmptyDescription>{emptyCopy.body}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}

          {filter.view === "drafts" && !loading && drafts.map((draft) => (
            <div key={draft.id} className="group/row flex items-center gap-1 rounded-xl hover:bg-accent">
              <Button
                variant="ghost"
                className="h-auto sm:h-auto min-w-0 flex-1 flex-col items-start gap-0.5 whitespace-normal px-3 py-2.5 text-left hover:bg-transparent"
                onClick={() =>
                  onCompose({
                    draftId: draft.id, mailboxId: draft.mailboxId, threadId: draft.threadId,
                    replyToMessageId: draft.replyToMessageId, to: draft.toRecipients, cc: draft.ccRecipients,
                    bcc: draft.bccRecipients, subject: draft.subject, html: draft.html, uploadIds: draft.uploadIds,
                  })
                }
              >
                <span className="w-full truncate font-medium text-foreground text-sm">{draft.subject || "(no subject)"}</span>
                <span className="w-full truncate font-normal text-muted-foreground text-xs">To: {draft.toRecipients.join(", ") || "nobody yet"}</span>
              </Button>
              <IconAction
                label="Discard draft"
                className="me-2 opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100"
                onClick={async () => {
                  await call("/drafts/delete", { id: draft.id });
                  load();
                }}
              >
                <Trash />
              </IconAction>
            </div>
          ))}

          {filter.view === "scheduled" && !loading && scheduled.map((item) => (
            <div key={item.id} className="flex items-center gap-2 rounded-xl px-3 py-2.5 hover:bg-accent">
              <div className="min-w-0 flex-1">
                <span className="block truncate font-medium text-foreground text-sm">{item.subject || "(no subject)"}</span>
                {item.status === "failed" ? (
                  <Badge variant="error" size="sm" className="mt-1">Couldn&apos;t send</Badge>
                ) : (
                  <span className="block truncate text-muted-foreground text-xs">Sends {new Date(item.sendAt).toLocaleString()}</span>
                )}
              </div>
              {item.status === "scheduled" && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    try {
                      onCompose(await call("/mail/cancel", { id: item.id }));
                      load();
                    } catch (error) {
                      notifyError(error);
                    }
                  }}
                >
                  Edit
                </Button>
              )}
            </div>
          ))}

          {!isSpecial && !loading && (
            <ContextMenu disabled={touch} onOpenChange={(open) => !open && setMenuRow(null)}>
            <ContextMenuTrigger render={<ul className="space-y-0.5" />}>
              {threads.map((thread) => {
                const sender = senderOf(thread);
                const selected = thread.id === selectedId;
                const checked = selectedIds.has(thread.id);
                return (
                  <li
                    key={thread.id}
                    className={cn("group/row relative select-none [-webkit-touch-callout:none]", dragging.has(thread.id) && "opacity-50")}
                    // Drag onto a folder or label in the sidebar. A checked row brings the whole selection.
                    draggable={!touch}
                    onDragStart={(event) => {
                      cancelPress();
                      startThreadDrag(event, { targets: checked ? picked : [thread], run });
                    }}
                    onDragEnd={endThreadDrag}
                    onPointerDown={(event) => startPress(event, thread.id)}
                    onPointerMove={movePress}
                    onPointerUp={cancelPress}
                    onPointerCancel={cancelPress}
                    onPointerLeave={cancelPress}
                    onContextMenu={() => {
                      // Right-clicking a selected row acts on the whole selection; any other row, on itself.
                      setMenuFor(checked ? picked : [thread]);
                      setMenuRow(thread.id);
                    }}
                  >
                    <Button
                      variant="ghost"
                      aria-current={selected ? "true" : undefined}
                      aria-pressed={selecting ? checked : undefined}
                      onClick={(event) => {
                        if (pressed.current) {
                          pressed.current = false;
                          return;
                        }
                        const onAvatar = (event.target as HTMLElement).closest("[data-select]");
                        if (selecting || onAvatar || event.metaKey || event.ctrlKey || event.shiftKey) {
                          toggle(thread.id, event.shiftKey);
                          return;
                        }
                        onSelect(thread.id);
                      }}
                      className={cn(
                        "h-auto sm:h-auto w-full items-start justify-start gap-3 whitespace-normal rounded-xl border-transparent px-3 py-2.5 text-left font-normal transition-colors duration-150",
                        selected && "bg-brand-soft hover:bg-brand-soft",
                        checked && "bg-accent hover:bg-accent",
                        menuRow === thread.id && "ring-1 ring-ring/40",
                      )}
                    >
                      <span data-select className="relative size-8 shrink-0" title={checked ? "Deselect" : "Select"}>
                        <SenderAvatar
                          name={sender}
                          className={cn("transition-opacity", (selecting || checked) ? "opacity-0" : !touch && "group-hover/row:opacity-0")}
                        />
                        <span
                          aria-hidden="true"
                          className={cn(
                            "absolute inset-0 flex items-center justify-center rounded-full transition-opacity",
                            (selecting || checked) ? "opacity-100" : cn("opacity-0", !touch && "group-hover/row:opacity-100"),
                          )}
                        >
                          <span
                            className={cn(
                              "flex size-5 items-center justify-center rounded-md border",
                              checked ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background",
                            )}
                          >
                            {checked && <Check weight="bold" className="size-3.5" />}
                          </span>
                        </span>
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-2">
                          <span className={cn("min-w-0 flex-1 truncate text-sm", thread.unread ? "font-semibold text-foreground" : "text-muted-foreground")}>
                            {sender}
                            {thread.messageCount > 1 && <span className="ms-1.5 font-normal text-muted-foreground text-xs tabular-nums">{thread.messageCount}</span>}
                          </span>
                          <time className="shrink-0 text-muted-foreground text-xs tabular-nums">{formatListTime(thread.lastMessageAt)}</time>
                        </span>
                        <span className={cn("block truncate text-sm", thread.unread ? "font-medium text-foreground" : "text-muted-foreground")}>
                          {thread.subject || "(no subject)"}
                        </span>
                        <span className="flex items-center gap-1.5 pe-5">
                          <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">{thread.snippet}</span>
                          {thread.hasAttachments && <Paperclip aria-label="Has attachments" className="size-3 shrink-0 text-muted-foreground" />}
                          {thread.labels.slice(0, 1).map((label) => <LabelChip key={label.id} label={label} />)}
                          {thread.assignee && filter.view !== "assigned" && (
                            <Tooltip>
                              <TooltipTrigger render={<span className="shrink-0" />}>
                                <SenderAvatar name={thread.assignee.name} src={thread.assignee.image} className="size-4" fallbackClassName="text-[0.45rem]" />
                                <span className="sr-only">Assigned to {thread.assignee.name}</span>
                              </TooltipTrigger>
                              <TooltipPopup>Assigned to {thread.assignee.name}</TooltipPopup>
                            </Tooltip>
                          )}
                        </span>
                      </span>
                    </Button>
                    {thread.unread && <span aria-label="Unread" className="pointer-events-none absolute top-[1.3rem] left-1 size-1.5 rounded-full bg-brand" />}
                    <IconAction
                      label={thread.starred ? "Remove star" : "Add star"}
                      aria-pressed={thread.starred}
                      onClick={() => toggleStar(thread)}
                      size="icon-xs"
                      className={cn(
                        "absolute right-2.5 bottom-2 transition-opacity focus-visible:opacity-100 group-hover/row:opacity-100",
                        thread.starred ? "text-amber-500 opacity-100" : "opacity-0",
                      )}
                    >
                      <Star weight={thread.starred ? "fill" : "regular"} />
                    </IconAction>
                  </li>
                );
              })}
            </ContextMenuTrigger>
            <ContextMenuPopup className="w-56">
              <ThreadActionItems
                kit={CONTEXT_KIT}
                targets={menuFor}
                view={filter.view}
                labels={labels}
                run={run}
                onSelect={selecting || menuFor.length !== 1 ? undefined : () => toggle(menuFor[0].id)}
              />
            </ContextMenuPopup>
            </ContextMenu>
          )}
          {cursor && !isSpecial && !loading && (
            <Button variant="ghost" className="mt-2 w-full" onClick={() => load(cursor)}>Load more</Button>
          )}
        </div>
      </ScrollArea>
      {dialog}
    </section>
  );
}
