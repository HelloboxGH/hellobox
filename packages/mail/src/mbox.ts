// Reading mail exported from other services. MBOX is one file holding every email, each
// starting with a "From " line; Gmail (Takeout), Apple Mail and Thunderbird all write it.
// Gmail adds X-Gmail-Labels and X-GM-THRID to each email, which say where it was filed.

// Bigger emails are skipped rather than held in memory. Gmail's own limit is 25 MB of
// attachments, which base64 turns into about 34 MB.
export const MAX_EMAIL_BYTES = 50 * 1024 * 1024;

export type MboxEntry =
  | { kind: "email"; raw: Uint8Array; offset: number }
  | { kind: "oversized"; offset: number };

const DAYS = "(Mon|Tue|Wed|Thu|Fri|Sat|Sun)";
// "From 1785…@xxx Wed Oct 18 08:51:23 +0000 2023" (Gmail), "From - Mon Jan 01 …"
// (Thunderbird), "From someone@example.com Mon Jan  1 …" (Apple Mail).
const SEPARATOR = new RegExp(`^From \\S+\\s+${DAYS} `);
const ESCAPED_FROM = /^>+From /;

const decoder = new TextDecoder("latin1");

function lineText(line: Uint8Array) {
  // Only the start matters, and latin1 maps every byte, so this never fails.
  return decoder.decode(line.subarray(0, Math.min(line.length, 80)));
}

function concat(parts: Uint8Array[], length: number) {
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const isBlank = (line: Uint8Array) =>
  line.length === 0 || (line.length === 1 && line[0] === 0x0d);

// Yields the emails in an MBOX stream one at a time, with how far into the file each one
// ends, so memory stays at about one email whatever the file's size.
export async function* readMbox(stream: ReadableStream<Uint8Array>): AsyncGenerator<MboxEntry> {
  let lines: Uint8Array[] = [];
  let length = 0;
  let oversized = false;
  let started = false;
  let previousBlank = true;
  let offset = 0;
  let pending = new Uint8Array(0);

  function* finish(): Generator<MboxEntry> {
    if (!started) return;
    // The blank line before a separator belongs to the MBOX format, not to the email.
    while (lines.length && isBlank(lines.at(-1)!)) lines.pop();
    if (oversized) yield { kind: "oversized", offset };
    else if (lines.length) yield { kind: "email", raw: joinLines(lines), offset };
    lines = [];
    length = 0;
    oversized = false;
  }

  function* line(bytes: Uint8Array): Generator<MboxEntry> {
    const text = lineText(bytes);
    if ((previousBlank || !started) && SEPARATOR.test(text)) {
      yield* finish();
      started = true;
      previousBlank = false;
      return;
    }
    // A file that doesn't start with a separator is treated as one email (an .eml).
    started = true;
    previousBlank = isBlank(bytes);
    if (oversized) return;
    const kept = ESCAPED_FROM.test(text) ? bytes.subarray(1) : bytes;
    length += kept.length + 1;
    if (length > MAX_EMAIL_BYTES) {
      oversized = true;
      lines = [];
      return;
    }
    lines.push(kept);
  }

  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = pending.length ? concat([pending, value], pending.length + value.length) : value;
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== 0x0a) continue;
      offset += i + 1 - start;
      yield* line(chunk.subarray(start, i));
      start = i + 1;
    }
    // Copied, so the reader's buffer can be reused.
    pending = chunk.slice(start);
  }
  if (pending.length) {
    offset += pending.length;
    yield* line(pending);
  }
  yield* finish();
}

function joinLines(lines: Uint8Array[]) {
  const out = new Uint8Array(lines.reduce((sum, line) => sum + line.length + 1, -1));
  let at = 0;
  lines.forEach((line, index) => {
    out.set(line, at);
    at += line.length;
    if (index < lines.length - 1) out[at++] = 0x0a;
  });
  return out;
}

// Splits "Inbox,\"Work, clients\",Starred" into its labels.
export function parseGmailLabels(value: string | undefined) {
  if (!value) return [];
  const labels: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of value) {
    if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) {
      labels.push(current);
      current = "";
    } else current += char;
  }
  labels.push(current);
  return labels.map((label) => label.trim()).filter(Boolean);
}

export type ImportPlacement = {
  folder: "inbox" | "archive" | "spam" | "trash";
  category: "primary" | "notifications" | "purchases" | "newsletters";
  sent: boolean;
  starred: boolean;
  unread: boolean;
  important: boolean;
  // Drafts and Hangouts chats aren't email, so they're skipped.
  skip: boolean;
  labels: string[];
};

const SYSTEM_LABELS = new Set([
  "inbox", "sent", "spam", "trash", "starred", "important", "unread", "opened", "archived",
  "drafts", "draft", "chat", "chats",
]);

const CATEGORIES: Record<string, ImportPlacement["category"]> = {
  "category promotions": "newsletters",
  "category social": "notifications",
  "category updates": "notifications",
  "category forums": "notifications",
  "category purchases": "purchases",
};

// Where an imported email goes. Without Gmail's labels (other services), received mail
// lands in the archive as read, and mail from the mailbox's own address counts as sent.
export function placementFor(labelHeader: string | undefined, fromSelf: boolean): ImportPlacement {
  const labels = parseGmailLabels(labelHeader);
  const has = (name: string) => labels.some((label) => label.toLowerCase() === name);
  const gmail = labels.length > 0;
  const sent = has("sent") || (!gmail && fromSelf);
  const folder = has("trash") ? "trash" : has("spam") ? "spam" : has("inbox") ? "inbox" : "archive";
  const category = labels.map((label) => CATEGORIES[label.toLowerCase()]).find(Boolean) ?? "primary";
  return {
    folder,
    category,
    sent,
    starred: has("starred"),
    unread: has("unread"),
    important: has("important"),
    skip: (has("drafts") || has("draft") || has("chat") || has("chats")) && !has("sent"),
    labels: labels.filter((label) => {
      const lower = label.toLowerCase();
      return !SYSTEM_LABELS.has(lower) && !lower.startsWith("category ") && !lower.startsWith("[imap]");
    }).slice(0, 20),
  };
}
