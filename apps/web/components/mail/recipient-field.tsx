"use client";

import { AddressBook, Check, MagnifyingGlass, Plus, UserPlus, X } from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState } from "react";
import { ContactDialog } from "@/components/campaigns/contacts-tab";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { call } from "@/core/client/api";
import { notifyError } from "@/core/client/notify";
import { cn } from "@/lib/utils";
import { IconAction } from "./icon-action";

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

type Suggestion = Awaited<ReturnType<typeof call<"/contacts/suggest">>>[number];

function useDebounced<T>(value: T, ms: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

// Addresses as chips. Typing suggests contacts and people already written to, and a new
// address can be saved as a contact on the spot. `browse` adds a button to pick contacts.
export function RecipientField({
  label, values, onChange, autoFocus, trailing, browse,
}: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  autoFocus?: boolean;
  trailing?: React.ReactNode;
  browse?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [active, setActive] = useState(0);
  const [saving, setSaving] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const query = useDebounced(text.trim(), 150);

  useEffect(() => {
    if (!query) return;
    let current = true;
    call("/contacts/suggest", { query, exclude: values })
      .then((found) => { if (current) { setSuggestions(found); setActive(0); } })
      .catch(() => undefined);
    return () => { current = false; };
  }, [query, values]);

  const typed = text.trim().toLowerCase();
  const canSave = EMAIL.test(typed) && !suggestions.some((s) => s.contact && s.address === typed);
  const options = [
    ...suggestions.map((suggestion) => ({ kind: "pick" as const, suggestion })),
    ...(canSave ? [{ kind: "save" as const, address: typed }] : []),
  ];
  const open = focused && Boolean(text.trim()) && options.length > 0;

  const add = (addresses: string[]) => {
    const fresh = addresses.filter((address) => !values.includes(address));
    if (fresh.length) onChange([...values, ...fresh]);
  };
  const commit = () => {
    add(text.split(/[,;\s]+/).map((part) => part.trim()).filter(Boolean));
    setText("");
  };
  const choose = (index: number) => {
    const option = options[index];
    if (!option) return commit();
    if (option.kind === "pick") {
      add([option.suggestion.address]);
      setText("");
    } else {
      // The address goes in straight away; the dialog only adds a name to keep.
      add([option.address]);
      setText("");
      setSaving(option.address);
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: clicking the row's gaps focuses its input.
    // biome-ignore lint/a11y/useKeyWithClickEvents: the input inside takes the keys.
    <div
      className="relative flex min-h-10 flex-wrap items-center gap-1.5 py-1.5"
      onClick={(event) => { if (event.target === event.currentTarget) input.current?.focus(); }}
    >
      <span className="w-10 shrink-0 text-muted-foreground text-sm">{label}</span>
      {values.map((address) => (
        <Badge key={address} variant={EMAIL.test(address) ? "secondary" : "error"} className="gap-1 pe-0.5">
          {address}
          <Button
            aria-label={`Remove ${address}`}
            onClick={() => onChange(values.filter((value) => value !== address))}
            size="icon-xs"
            variant="ghost"
            className="size-4 rounded-sm"
          >
            <X className="size-3!" />
          </Button>
        </Badge>
      ))}
      {/* A bare input, so it reads as one field with its chips. */}
      <input
        ref={input}
        autoFocus={autoFocus}
        aria-label={label}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        type="email"
        multiple
        value={text}
        onFocus={() => setFocused(true)}
        onChange={(event) => {
          setText(event.target.value);
          if (/[,;\s]$/.test(event.target.value)) queueMicrotask(commit);
        }}
        onBlur={() => {
          setFocused(false);
          commit();
        }}
        onKeyDown={(event) => {
          if (open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            setActive((index) => (index + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
          } else if (open && event.key === "Escape") {
            event.stopPropagation();
            setFocused(false);
          } else if (event.key === "Enter" || event.key === "Tab" || event.key === ",") {
            if (!text.trim()) return;
            event.preventDefault();
            // Enter takes the highlighted suggestion; Tab and comma keep exactly what was typed
            // unless it's only part of an address.
            if (open && (event.key === "Enter" || !EMAIL.test(typed))) choose(active);
            else commit();
          } else if (event.key === "Backspace" && !text && values.length) {
            onChange(values.slice(0, -1));
          }
        }}
        className="h-7 min-w-24 flex-1 bg-transparent text-foreground text-sm outline-none"
      />
      {browse && (
        <IconAction label="Choose contacts" onClick={() => setPicking(true)}><AddressBook /></IconAction>
      )}
      {trailing}

      {open && (
        <div id={listId} role="listbox" aria-label="Suggestions" className="absolute inset-x-0 top-full z-50 -mt-1 overflow-hidden rounded-xl border bg-popover p-1 shadow-lg">
          {options.map((option, index) => (
            <div
              key={option.kind === "pick" ? option.suggestion.address : "save"}
              role="option"
              aria-selected={index === active}
              tabIndex={-1}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(index)}
              onKeyDown={() => undefined}
              className={cn("flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm", index === active && "bg-accent")}
            >
              {option.kind === "pick" ? (
                <>
                  <span className="min-w-0 flex-1 truncate">
                    {option.suggestion.name && <span className="font-medium text-foreground">{option.suggestion.name} </span>}
                    <span className="text-muted-foreground">{option.suggestion.address}</span>
                  </span>
                  {option.suggestion.contact && <Badge variant="outline" size="sm">Contact</Badge>}
                </>
              ) : (
                <span className="flex items-center gap-2 text-foreground"><UserPlus /> Save {option.address} as a contact…</span>
              )}
            </div>
          ))}
        </div>
      )}

      <ContactDialog
        contact={saving ? "new" : null}
        fieldKeys={[]}
        initialEmail={saving ?? undefined}
        onClose={() => setSaving(null)}
        onSaved={() => setSaving(null)}
      />
      <ContactPicker open={picking} onOpenChange={setPicking} values={values} onToggle={(address) => (
        values.includes(address) ? onChange(values.filter((value) => value !== address)) : add([address])
      )} />
    </div>
  );
}

type ContactRow = Awaited<ReturnType<typeof call<"/contacts/list">>>["contacts"][number];

function ContactPicker({ open, onOpenChange, values, onToggle }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  values: string[];
  onToggle: (address: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<ContactRow[] | null>(null);
  const [fieldKeys, setFieldKeys] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const debounced = useDebounced(query.trim(), 200);

  const load = (search: string) =>
    call("/contacts/list", { query: search })
      .then((page) => { setRows(page.contacts); setFieldKeys(page.fieldKeys); })
      .catch(notifyError);
  // biome-ignore lint/correctness/useExhaustiveDependencies: load only reads the query it's given.
  useEffect(() => { if (open) load(debounced); }, [open, debounced]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Choose contacts</DialogTitle>
          <DialogDescription>Pick who to add, or add someone new to your contacts.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <div className="relative">
            <MagnifyingGlass className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input autoFocus aria-label="Search contacts" placeholder="Search by name or email" className="ps-7" value={query} onChange={(event) => setQuery(event.target.value)} />
          </div>
          <ul className="max-h-80 divide-y overflow-y-auto">
            {rows?.map((contact) => {
              const name = [contact.firstName, contact.lastName].filter(Boolean).join(" ");
              const added = values.includes(contact.email);
              return (
                <li key={contact.id}>
                  <button
                    type="button"
                    aria-pressed={added}
                    onClick={() => onToggle(contact.email)}
                    className="flex w-full cursor-pointer items-center gap-2 rounded-md px-1 py-2 text-start text-sm hover:bg-accent"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {name && <span className="font-medium text-foreground">{name} </span>}
                      <span className="text-muted-foreground">{contact.email}</span>
                    </span>
                    {added && <Check className="text-brand" weight="bold" />}
                  </button>
                </li>
              );
            })}
            {rows?.length === 0 && (
              <li className="py-6 text-center text-muted-foreground text-sm">{query.trim() ? "No contacts match." : "No contacts yet."}</li>
            )}
          </ul>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" className="me-auto" onClick={() => setCreating(true)}><Plus /> New contact</Button>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogPopup>
      <ContactDialog
        contact={creating ? "new" : null}
        fieldKeys={fieldKeys}
        initialEmail={EMAIL.test(query.trim()) ? query.trim().toLowerCase() : undefined}
        onClose={() => setCreating(false)}
        onSaved={(email) => {
          setCreating(false);
          onToggle(email);
          load(debounced);
        }}
      />
    </Dialog>
  );
}
