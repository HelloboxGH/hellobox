// What the composer turns into links and formatting as people type. Plain string functions,
// so they can be tested without a browser; composer-editor.ts applies them to the DOM.

// Words that look like domains but are file names. "notes.txt" should stay text.
const FILE_ENDINGS = new Set([
  "txt", "pdf", "png", "jpg", "jpeg", "gif", "svg", "webp", "heic", "mp3", "mp4", "mov", "wav", "zip", "rar", "gz", "tar",
  "csv", "json", "xml", "yml", "yaml", "md", "js", "ts", "tsx", "jsx", "css", "html", "htm", "py", "rb", "go", "rs",
  "java", "php", "sh", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "key", "pages", "numbers", "exe", "dmg", "apk",
  "log", "ini", "env", "lock", "sql", "psd", "ai", "fig", "eps", "ttf", "otf", "woff",
]);

const EMAIL = /^[\w.+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/i;
const URL_WITH_SCHEME = /^https?:\/\/[^\s<>"]+$/i;
const DOMAIN = /^(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,24})(?::\d{2,5})?(?:[/?#][^\s<>"]*)?$/i;

// Punctuation that ends a sentence rather than the link: "see hellobox.app." or "(hellobox.app)".
const TRAILING = /[.,;:!?'")\]}>]+$/;

/** A link found in a word: how much of the word it covers, and where it points. */
export interface FoundLink {
  /** Where the link starts in the word, after any opening bracket or quote. */
  start: number;
  text: string;
  href: string;
}

const LEADING = /^[("'<[{]+/;

/** The link at the start of a word, or null. Trailing punctuation stays outside the link. */
export function findLink(word: string): FoundLink | null {
  const start = LEADING.exec(word)?.[0].length ?? 0;
  const found = linkAt(word.slice(start));
  return found && { start, ...found };
}

function linkAt(word: string): Omit<FoundLink, "start"> | null {
  let text = word.replace(TRAILING, "");
  // Keep a closing bracket that has its opening one inside, as in wikipedia.org/wiki/Mail_(protocol).
  if (word.slice(text.length).startsWith(")") && (text.match(/\(/g)?.length ?? 0) > (text.match(/\)/g)?.length ?? 0)) {
    text += ")";
  }
  if (!text) return null;
  if (EMAIL.test(text)) return { text, href: `mailto:${text}` };
  if (text.includes("@")) return null;
  if (URL_WITH_SCHEME.test(text)) return /^https?:\/\/[^/]+\.[^/]+/i.test(text) || /^https?:\/\/localhost/i.test(text) ? { text, href: text } : null;
  const domain = DOMAIN.exec(text);
  if (!domain) return null;
  const ending = domain[1]!.toLowerCase();
  // Only bare "name.ext" counts as a file; "example.com/file.pdf" is still a link.
  if (FILE_ENDINGS.has(ending) && !/[/?#:]/.test(text)) return null;
  return { text, href: `https://${text}` };
}

/** Pieces of a text: plain runs and links, in order. Used when text arrives all at once. */
export function splitLinks(text: string): ({ text: string; href?: string })[] {
  const parts: { text: string; href?: string }[] = [];
  let plain = "";
  for (const piece of text.split(/(\s+)/)) {
    const found = piece && !/^\s+$/.test(piece) ? findLink(piece) : null;
    if (!found) {
      plain += piece;
      continue;
    }
    plain += piece.slice(0, found.start);
    if (plain) parts.push({ text: plain });
    plain = piece.slice(found.start + found.text.length);
    parts.push({ text: found.text, href: found.href });
  }
  if (plain) parts.push({ text: plain });
  return parts;
}

export type InlineTag = "strong" | "em" | "code" | "s" | "a";

/** Markdown that just closed at the end of the text: where it starts, and what it becomes. */
export interface InlineMatch {
  start: number;
  tag: InlineTag;
  text: string;
  href?: string;
}

// Each pattern must end at the end of the text, where the caret is.
const INLINE: { tag: InlineTag; pattern: RegExp }[] = [
  { tag: "a", pattern: /\[([^\]\n]+)\]\(([^)\s]+)\)$/ },
  { tag: "strong", pattern: /(?:^|[^*\\])(\*\*([^*\s](?:[^*]*[^*\s])?)\*\*)$/ },
  { tag: "strong", pattern: /(?:^|[^_\w\\])(__([^_\s](?:[^_]*[^_\s])?)__)$/ },
  { tag: "s", pattern: /(?:^|[^~\\])(~~([^~\s](?:[^~]*[^~\s])?)~~)$/ },
  { tag: "code", pattern: /(?:^|[^`\\])(`([^`\n]+)`)$/ },
  { tag: "em", pattern: /(?:^|[^*\\])(\*([^*\s](?:[^*]*[^*\s])?)\*)$/ },
  { tag: "em", pattern: /(?:^|[^_\w\\])(_([^_\s](?:[^_]*[^_\s])?)_)$/ },
];

/** Inline Markdown (**bold**, *italic*, `code`, ~~strike~~, [text](link)) closed by the last character. */
export function matchInline(text: string): InlineMatch | null {
  for (const { tag, pattern } of INLINE) {
    const match = pattern.exec(text);
    if (!match) continue;
    if (tag === "a") {
      const href = findLink(match[2]!)?.href ?? (/^(https?:|mailto:)/i.test(match[2]!) ? match[2]! : null);
      if (!href) continue;
      return { start: match.index, tag, text: match[1]!, href };
    }
    const whole = match[1]!;
    return { start: text.length - whole.length, tag, text: match[2]! };
  }
  return null;
}

export type BlockFormat =
  | { command: "formatBlock"; value: "h1" | "h2" | "h3" | "blockquote" | "pre" }
  | { command: "insertUnorderedList" | "insertOrderedList" };

/** A Markdown line start ("# ", "- ", "1. ", "> ", "``` ") typed at the start of a line, before its space. */
export function matchBlock(lineStart: string): BlockFormat | null {
  switch (lineStart) {
    case "#": return { command: "formatBlock", value: "h1" };
    case "##": return { command: "formatBlock", value: "h2" };
    case "###": return { command: "formatBlock", value: "h3" };
    case ">": return { command: "formatBlock", value: "blockquote" };
    case "```": return { command: "formatBlock", value: "pre" };
    case "-": case "*": case "+": return { command: "insertUnorderedList" };
    case "1.": case "1)": return { command: "insertOrderedList" };
    default: return null;
  }
}

/** The HTML that goes out: no zero-width spaces the editor used to park the caret. */
export function cleanEditorHtml(html: string) {
  return html.replace(/\u200B/g, "");
}
