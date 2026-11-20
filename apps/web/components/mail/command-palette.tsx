"use client";

import {
  ArrowDown, ArrowUp, ArrowBendDownLeft, Desktop, Gear, MagnifyingGlass, Moon, PencilSimple, Sun, Tray,
} from "@phosphor-icons/react";
import { Fragment, type ReactNode, useMemo, useState } from "react";
import { ACCENTS, setAccent, setTheme } from "@/components/theme";
import {
  Command, CommandCollection, CommandDialog, CommandDialogPopup, CommandEmpty, CommandFooter, CommandGroup,
  CommandGroupLabel, CommandInput, CommandItem, CommandList, CommandPanel, CommandSeparator, CommandShortcut,
} from "@/components/ui/command";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import type { Bootstrap } from "@/core/client/api";
import { type MailFilter, TEAM_VIEWS, VIEW_TITLES, type View } from "./types";

interface Item {
  value: string;
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  run: () => void;
}

export function CommandPalette({
  open, onOpenChange, data, onFilter, onCompose, onSearch,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: Bootstrap;
  onFilter: (filter: MailFilter) => void;
  onCompose: () => void;
  onSearch: (query: string) => void;
}) {
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const views = (Object.entries(VIEW_TITLES) as [View, string][]).filter(
      ([view]) => data.entitlements.features.team || !TEAM_VIEWS.has(view),
    );
    const result: { value: string; items: Item[] }[] = [
      {
        value: "Actions",
        items: [
          { value: "compose", label: "New message", icon: <PencilSimple />, shortcut: "C", run: onCompose },
          { value: "settings", label: "Open settings", icon: <Gear />, run: () => { window.location.href = "/settings"; } },
        ],
      },
      {
        value: "Go to",
        items: views.map(([view, label]) => ({ value: `view-${view}`, label, icon: <Tray />, run: () => onFilter({ view }) })),
      },
    ];
    if (data.mailboxes.length > 1) {
      result.push({
        value: "Mailboxes",
        items: data.mailboxes.map((mailbox) => ({
          value: mailbox.id,
          label: mailbox.address,
          run: () => onFilter({ view: "inbox", mailboxId: mailbox.id }),
        })),
      });
    }
    result.push({
      value: "Theme",
      items: [
        { value: "theme-system", label: "Use system theme", icon: <Desktop />, run: () => setTheme("system") },
        { value: "theme-light", label: "Use light theme", icon: <Sun />, run: () => setTheme("light") },
        { value: "theme-dark", label: "Use dark theme", icon: <Moon />, run: () => setTheme("dark") },
      ],
    });
    result.push({
      value: "Accent",
      items: ACCENTS.map((accent) => ({
        value: `accent-${accent.value}`,
        label: `Use ${accent.label.toLowerCase()} accent`,
        icon: <span aria-hidden className="size-3.5 rounded-full" style={{ backgroundColor: accent.color }} />,
        run: () => setAccent(accent.value),
      })),
    });
    return result;
  }, [data.mailboxes, data.entitlements.features.team, onCompose, onFilter]);

  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) setQuery("");
  };
  const searchMail = () => {
    onSearch(query.trim());
    close(false);
  };

  return (
    <CommandDialog open={open} onOpenChange={close}>
      <CommandDialogPopup>
        <Command
          items={groups}
          filter={(item: unknown, text: string) => (item as Item).label.toLowerCase().includes(text.toLowerCase())}
        >
          <CommandInput
            placeholder="Search mail, or jump anywhere…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && query.trim()) {
                event.preventDefault();
                searchMail();
              }
            }}
          />
          <CommandPanel>
            <CommandEmpty className="not-empty:py-10">
              {query.trim() && (
                <button type="button" onClick={searchMail} className="inline-flex items-center gap-2 text-foreground text-sm">
                  <MagnifyingGlass /> Search mail for “{query.trim()}”
                </button>
              )}
            </CommandEmpty>
            <CommandList>
              {(group: { value: string; items: Item[] }) => (
                <Fragment key={group.value}>
                  <CommandGroup items={group.items}>
                    <CommandGroupLabel>{group.value}</CommandGroupLabel>
                    <CommandCollection>
                      {(item: Item) => (
                        <CommandItem
                          key={item.value}
                          className="gap-2.5 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"
                          value={item}
                          onClick={() => {
                            item.run();
                            close(false);
                          }}
                        >
                          {item.icon}
                          <span className="flex-1">{item.label}</span>
                          {item.shortcut && <CommandShortcut>{item.shortcut}</CommandShortcut>}
                        </CommandItem>
                      )}
                    </CommandCollection>
                  </CommandGroup>
                  <CommandSeparator />
                </Fragment>
              )}
            </CommandList>
          </CommandPanel>
          <CommandFooter>
            <div className="flex items-center gap-4">
              <span className="flex items-center gap-2">
                <KbdGroup><Kbd><ArrowUp /></Kbd><Kbd><ArrowDown /></Kbd></KbdGroup> Navigate
              </span>
              <span className="flex items-center gap-2"><Kbd><ArrowBendDownLeft /></Kbd> Open</span>
            </div>
            <span className="hidden items-center gap-2 sm:flex"><KbdGroup><Kbd>⌘</Kbd><Kbd><ArrowBendDownLeft /></Kbd></KbdGroup> Search mail</span>
          </CommandFooter>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
