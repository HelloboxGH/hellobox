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
