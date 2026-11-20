import type { Address } from "@hellobox/db";

const REPLY_PREFIX = /^\s*((re|fw|fwd|aw|wg|tr|rv)(\[\d+\])?\s*:\s*)+/i;

export function normalizeSubject(subject: string) {
  return subject.replace(REPLY_PREFIX, "").replace(/\s+/g, " ").trim().toLowerCase();
}

export const isReplySubject = (subject: string) => REPLY_PREFIX.test(subject);

export function parseMessageIds(value: string | string[] | undefined | null) {
  if (!value) return [];
  const raw = Array.isArray(value) ? value.join(" ") : value;
  return raw.match(/<[^<>\s]+>/g) ?? [];
}

export function parseAddress(value: string): Address {
  const match = value.match(/^\s*(?:"?([^"<]*?)"?\s*)?<([^<>]+)>\s*$/);
  if (match?.[2]) {
    const name = match[1]?.trim();
    return {
      address: match[2].trim().toLowerCase(),
      ...(name ? { name } : {}),
    };
  }
  return { address: value.trim().toLowerCase() };
}

export function parseAddressList(values: string[] | null | undefined) {
  return (values ?? []).filter(Boolean).map(parseAddress);
}

export const domainOf = (address: string) =>
  address.slice(address.lastIndexOf("@") + 1).toLowerCase();

export function makeSnippet(text: string | null | undefined, html?: string | null) {
  const source =
    text ??
    (html ?? "")
      .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ");
  return source
    .replace(/^>.*$/gm, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

// The ids a new message points at, closest ancestor first.
export function threadLookupIds(
  inReplyTo: string | null | undefined,
  references: string[],
) {
  return [
    ...new Set([...parseMessageIds(inReplyTo), ...[...references].reverse()]),
  ];
}

const FALLBACK_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// Used only when headers are missing: a reply-prefixed subject sharing a participant.
export function matchesByFallback(
  message: { subject: string; participants: string[]; sentAt: Date },
  thread: {
    normalizedSubject: string;
    participants: Address[];
    lastMessageAt: Date;
  },
) {
  const subject = normalizeSubject(message.subject);
  if (!subject || !isReplySubject(message.subject)) return false;
  if (subject !== thread.normalizedSubject) return false;
  const age = message.sentAt.getTime() - thread.lastMessageAt.getTime();
  if (Math.abs(age) > FALLBACK_WINDOW_MS) return false;
  const known = new Set(thread.participants.map((p) => p.address));
  return message.participants.some((address) => known.has(address));
}
