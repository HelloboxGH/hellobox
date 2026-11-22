"use client";

import { Bell } from "@phosphor-icons/react";
import { type RefObject, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { useSidebar } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { call } from "@/core/client/api";
import { errorMessage, notifyError } from "@/core/client/notify";
import { cn } from "@/lib/utils";
import { SenderAvatar } from "./sender-avatar";
import { formatListTime } from "./types";

type Item = Awaited<ReturnType<typeof call<"/notifications/inbox">>>["items"][number];

// The bell beside the account menu: what teammates did that this person should see, such as
// assigning them a conversation or mentioning them. The same things are emailed (see
// sendTeamEmail); here they wait until opened. Rows read like the thread list.
export function NotificationsBell({
  unread, anchor, onOpenThread, onChanged,
}: {
  unread: number;
  // The footer row: on phones the panel sits flush on it, as wide as the sidebar.
  anchor: RefObject<HTMLElement | null>;
  onOpenThread: (threadId: string) => void;
  onChanged: () => void;
}) {
  const { isMobile } = useSidebar();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Item[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const load = useCallback(
    () =>
      call("/notifications/inbox")
        .then((result) => {
          setItems(result.items);
          setFailed(null);
        })
        .catch((error: unknown) => setFailed(errorMessage(error))),
    [],
  );
  // Loads when opened, and again when something new arrives while it's open.
  useEffect(() => {
    if (open) void load();
  }, [open, unread, load]);

  const markRead = (ids?: string[]) =>
    call("/notifications/inbox/read", { ids }).then(onChanged).catch(notifyError);

  const openItem = (item: Item) => {
    setOpen(false);
    onOpenThread(item.threadId);
    if (!item.readAt) void markRead([item.id]);
  };

  const label = unread ? `Notifications, ${unread} unread` : "Notifications";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button variant="ghost" size="icon" aria-label={label} title="Notifications" className="relative shrink-0" />}
      >
        <Bell weight={unread ? "fill" : "regular"} className={cn(unread && "text-foreground")} />
        {unread > 0 && (
          <span
            aria-hidden
            className="absolute top-0.5 right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 font-semibold text-[0.625rem] text-brand-contrast tabular-nums leading-none"
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </PopoverTrigger>
      <PopoverPopup
        side="top"
        align="start"
        anchor={isMobile ? anchor : undefined}
        sideOffset={isMobile ? 4 : 8}
        // Rows run to the frame's own padding, like the app's menus.
        className={cn(
          "rounded-xl before:rounded-[calc(var(--radius-xl)-1px)] [--viewport-inline-padding:--spacing(1)] **:data-[slot=popover-viewport]:py-1",
          isMobile ? "w-(--anchor-width)" : "w-88",
        )}
      >
        <div className="flex items-center justify-between gap-2 py-1 ps-3 pe-1">
          <PopoverTitle className="font-semibold text-sm">Notifications</PopoverTitle>
          {unread > 0 && (
            <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => void markRead().then(load)}>
              Mark all read
            </Button>
          )}
        </div>
        <div className="max-h-[min(26rem,60dvh)] overflow-y-auto overscroll-contain">
          {failed ? (
            <p className="px-3 py-6 text-center text-muted-foreground text-sm">{failed}</p>
          ) : items === null ? (
            <div className="space-y-1 p-1">
              {[0, 1].map((i) => (
                <div key={i} className="flex gap-3 px-2 py-2.5">
                  <Skeleton className="size-8 shrink-0 rounded-full" />
                  <div className="flex-1 space-y-2 py-0.5">
                    <Skeleton className="h-3 w-2/5" />
                    <Skeleton className="h-3 w-4/5" />
                  </div>
                </div>
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center gap-1 px-6 pt-6 pb-7 text-center">
              <Bell className="mb-1 size-6 text-muted-foreground" />
              <p className="font-medium text-foreground text-sm">You&apos;re all caught up</p>
              <p className="text-muted-foreground text-xs">Assignments and @mentions from your team show up here.</p>
            </div>
          ) : (
            <ul className="space-y-0.5">
              {items.map((item) => (
                <li key={item.id} className="relative">
                  <Row item={item} onOpen={() => openItem(item)} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

// Same shape as a thread row: avatar, who and when, the conversation, then what they did.
function Row({ item, onOpen }: { item: Item; onOpen: () => void }) {
  const actor = item.actor?.name ?? "Someone";
  const unread = !item.readAt;
  return (
    <>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left outline-none transition-colors duration-150 hover:bg-accent focus-visible:bg-accent"
      >
        <SenderAvatar name={actor} src={item.actor?.image} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className={cn("min-w-0 flex-1 truncate text-sm", unread ? "font-semibold text-foreground" : "text-muted-foreground")}>
              {actor}
            </span>
            <time dateTime={new Date(item.createdAt).toISOString()} className="shrink-0 text-muted-foreground text-xs tabular-nums">
              {formatListTime(item.createdAt)}
            </time>
          </span>
          <span className={cn("block truncate text-sm", unread ? "font-medium text-foreground" : "text-muted-foreground")}>
            {item.subject || "(no subject)"}
          </span>
          <span className="block truncate text-muted-foreground text-xs">
            {item.kind === "mentioned" ? `Mentioned you${item.note ? `: ${item.note}` : ""}` : "Assigned to you"}
          </span>
        </span>
      </button>
      {unread && <span aria-label="Unread" className="pointer-events-none absolute top-[1.3rem] left-1 size-1.5 rounded-full bg-brand" />}
    </>
  );
}
