// What a customer typed, made safe to store: Postgres takes no NUL and no half of a
// surrogate pair, and nothing here needs other control characters.
export const cleanText = (value: string) =>
  value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/\p{Surrogate}/gu, "�");

export const cleanLine = (value: string) => cleanText(value).replace(/\s+/g, " ").trim();

const SUBJECT_LENGTH = 80;

// A conversation with no subject gets its first line.
export function subjectFrom(text: string) {
  const line = cleanLine(text.split("\n").find((part) => part.trim()) ?? "");
  return line.length > SUBJECT_LENGTH ? `${line.slice(0, SUBJECT_LENGTH - 1).trimEnd()}…` : line || "New message";
}

const ENTITIES: Record<string, string> = { nbsp: " ", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", amp: "&" };

/** Plain text from an email's HTML, for reading only, never for showing as HTML. */
export function textFromHtml(html: string) {
  return html
    .replace(/<(style|script|head|title)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(nbsp|lt|gt|quot|#39|apos|amp);/g, (_, name: string) => ENTITIES[name] ?? "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Where quoted history starts in HTML: HelloBox's own quote, Gmail's, Outlook's and Apple Mail's.
const QUOTED_HTML = /<blockquote|<div[^>]+(class="[^"]*gmail_quote|id="(divRplyFwdMsg|appendonsend)")/i;
// And in text: "On … wrote:", the lines of a forward or an Outlook reply, or "> " lines.
const QUOTED_LINE = /^(>|-{2,}\s*(original|forwarded) message|_{10,}\s*$|from:\s.+@)/i;
const ATTRIBUTION = /^(on|le|am|el|il|op)\s.+(wrote|écrit|schrieb|escribió|scritto|schreef)\s*:?\s*$/i;

/** The new part of a message, without the history it quotes. */
export function withoutQuotes(message: { textBody: string | null; htmlBody: string | null }) {
  const html = message.htmlBody;
  const quoted = html?.search(QUOTED_HTML) ?? -1;
  const text = html ? textFromHtml(quoted === -1 ? html : html.slice(0, quoted)) : (message.textBody ?? "");
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const end = lines.findIndex((line, index) => {
    const trimmed = line.trim();
    // Gmail wraps a long attribution over two lines.
    return QUOTED_LINE.test(trimmed) || ATTRIBUTION.test(trimmed) || ATTRIBUTION.test(`${trimmed} ${lines[index + 1]?.trim() ?? ""}`);
  });
  return (end === -1 ? lines : lines.slice(0, end)).join("\n").trim();
}
