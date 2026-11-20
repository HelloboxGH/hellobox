"use client";

import { type KeyboardEvent, type ReactNode, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { SenderAvatar } from "./sender-avatar";

export type Mentionable = { id: string; name: string; image?: string | null };

// The "@que" being typed right before the caret, if any. A mention can hold spaces once it's
// picked ("@Amara Okafor"), but while typing, a space ends the search.
function activeQuery(text: string, caret: number) {
  const match = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  return match ? { start: caret - match[2]!.length - 1, query: match[2]! } : null;
}

/**
 * A one-line input where "@" suggests teammates. Picking one writes "@Full Name", which is
 * what the server looks for (see mentionedIn), so typing the name out works the same.
 */
export function MentionInput({
  value, onChange, people, placeholder, ariaLabel, className,
}: {
  value: string;
  onChange: (value: string) => void;
  people: Mentionable[];
  placeholder?: string;
  ariaLabel: string;
  className?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);

  const active = activeQuery(value, caret);
  const matches = active
    ? people.filter((person) => person.name.toLowerCase().includes(active.query.toLowerCase())).slice(0, 6)
    : [];
  const open = Boolean(active && matches.length && dismissed !== active.start);
  const index = Math.min(highlight, Math.max(matches.length - 1, 0));

  const pick = (person: Mentionable) => {
    if (!active) return;
    const before = value.slice(0, active.start);
    const after = value.slice(caret).replace(/^\S*/, "");
    const inserted = `@${person.name} `;
    onChange(before + inserted + after.replace(/^\s+/, ""));
    const next = before.length + inserted.length;
    setCaret(next);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(next, next);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!open) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setHighlight((index + step + matches.length) % matches.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      pick(matches[index]!);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setDismissed(active!.start);
    }
  };

  const track = () => setCaret(input.current?.selectionStart ?? value.length);

  return (
    <div className="relative min-w-0 flex-1">
      <input
        ref={input}
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls={open ? "mention-list" : undefined}
        aria-activedescendant={open ? `mention-${matches[index]?.id}` : undefined}
        placeholder={placeholder}
        value={value}
        className={cn("w-full min-w-0 bg-transparent outline-none placeholder:text-muted-foreground", className)}
        onChange={(event) => {
          onChange(event.target.value);
          setCaret(event.target.selectionStart ?? event.target.value.length);
          setHighlight(0);
          setDismissed(null);
        }}
        onKeyDown={onKeyDown}
        onKeyUp={track}
        onClick={track}
        onBlur={() => setTimeout(() => setDismissed(active?.start ?? null), 150)}
      />
      {open && (
        <ul
          id="mention-list"
          role="listbox"
          aria-label="Mention a teammate"
          className="absolute bottom-full left-0 z-20 mb-2 w-64 max-w-[calc(100vw-3rem)] rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg/5"
        >
          {matches.map((person, i) => (
            <li
              key={person.id}
              id={`mention-${person.id}`}
              role="option"
              aria-selected={i === index}
              className={cn("flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm", i === index && "bg-accent")}
              onMouseEnter={() => setHighlight(i)}
              // Keeps focus in the input, so the pick lands where the caret is.
              onMouseDown={(event) => {
                event.preventDefault();
                pick(person);
              }}
            >
              <SenderAvatar name={person.name} src={person.image} className="size-5" fallbackClassName="text-[0.5rem]" />
              <span className="truncate">{person.name}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A note's text with its @mentions picked out. */
export function withMentions(body: string, names: string[]): ReactNode[] {
  const tags = names
    .filter((name) => name.trim())
    .map((name) => `@${name.trim()}`)
    .sort((a, b) => b.length - a.length);
  if (!tags.length) return [body];
  const escaped = tags.map((tag) => tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const parts = body.split(new RegExp(`(${escaped.join("|")})(?![\\p{L}\\p{N}_])`, "giu"));
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <span key={i} className="rounded bg-brand/15 px-0.5 font-medium text-brand-foreground">{part}</span>
    ) : (
      part
    ),
  );
}
