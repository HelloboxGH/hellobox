"use client";

import { MagnifyingGlass, Tray } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import type { Bootstrap } from "@/core/client/api";

type Mailbox = Pick<Bootstrap["mailboxes"][number], "id" | "address" | "displayName">;

const domainOf = (address: string) => address.slice(address.indexOf("@") + 1);

// Picks mailboxes for a teammate: searchable, grouped by domain, with a checkbox per
// domain for giving or taking away a whole domain at once.
export function MailboxPicker({ mailboxes, selected, onChange }: {
  mailboxes: Mailbox[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const chosen = new Set(selected);

  const groups = useMemo(() => {
    const term = query.trim().toLowerCase();
    const shown = mailboxes.filter(
      (mailbox) =>
        !term ||
        mailbox.address.toLowerCase().includes(term) ||
        (mailbox.displayName ?? "").toLowerCase().includes(term),
    );
    const byDomain = new Map<string, Mailbox[]>();
    for (const mailbox of shown) {
      const domain = domainOf(mailbox.address);
      byDomain.set(domain, [...(byDomain.get(domain) ?? []), mailbox]);
    }
    return [...byDomain.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [mailboxes, query]);

  const shownIds = groups.flatMap(([, items]) => items.map((mailbox) => mailbox.id));
  const setMany = (ids: string[], on: boolean) => {
    const next = new Set(chosen);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    onChange([...next]);
  };
  const allShownChosen = shownIds.length > 0 && shownIds.every((id) => chosen.has(id));

  if (mailboxes.length === 0) {
    return <p className="text-muted-foreground text-sm">No mailboxes yet. Add one under Domains.</p>;
  }

  return (
    <div className="space-y-3">
      <InputGroup>
        <InputGroupAddon><MagnifyingGlass /></InputGroupAddon>
        <InputGroupInput
          type="search"
          aria-label="Search mailboxes"
          placeholder="Search by address or name"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          autoFocus
        />
      </InputGroup>
      <div className="flex items-center justify-between text-muted-foreground text-xs">
        <span className="tabular-nums">{selected.length} of {mailboxes.length} selected</span>
        {shownIds.length > 0 && (
          <button type="button" className="font-medium text-foreground underline-offset-2 hover:underline" onClick={() => setMany(shownIds, !allShownChosen)}>
            {allShownChosen ? (query ? "Clear these" : "Clear all") : query ? "Select these" : "Select all"}
          </button>
        )}
      </div>
      <div className="-mx-1 max-h-80 space-y-3 overflow-y-auto px-1">
        {groups.map(([domain, items]) => {
          const ids = items.map((mailbox) => mailbox.id);
          const count = ids.filter((id) => chosen.has(id)).length;
          return (
            <section key={domain} className="rounded-xl border">
              <Label className="flex items-center gap-2 border-b bg-muted/50 px-3 py-2">
                <Checkbox
                  checked={count === ids.length}
                  indeterminate={count > 0 && count < ids.length}
                  onCheckedChange={(checked) => setMany(ids, checked === true)}
                />
                <span className="min-w-0 flex-1 truncate font-medium text-foreground text-sm">{domain}</span>
                <span className="text-muted-foreground text-xs tabular-nums">{count}/{ids.length}</span>
              </Label>
              <ul>
                {items.map((mailbox) => (
                  <li key={mailbox.id}>
                    <Label className="flex items-center gap-3 px-3 py-2 hover:bg-muted/40">
                      <Checkbox
                        checked={chosen.has(mailbox.id)}
                        onCheckedChange={(checked) => setMany([mailbox.id], checked === true)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-foreground text-sm">{mailbox.displayName || mailbox.address}</span>
                        {mailbox.displayName && <span className="block truncate text-muted-foreground text-xs">{mailbox.address}</span>}
                      </span>
                    </Label>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
        {groups.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-8 text-center text-muted-foreground text-sm">
            <Tray className="size-6" />
            No mailboxes match “{query}”.
          </div>
        )}
      </div>
    </div>
  );
}
