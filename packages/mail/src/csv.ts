// RFC 4180 CSV: quoted fields, doubled quotes, and line breaks inside quotes. Commas,
// semicolons and tabs are detected from the header row. No imports, so the browser
// can parse a file before uploading it.

export function detectDelimiter(text: string) {
  const header = text.slice(0, text.search(/\r?\n|$/));
  const counts = [",", ";", "\t"].map((delimiter) => ({
    delimiter,
    count: header.split(delimiter).length - 1,
  }));
  counts.sort((a, b) => b.count - a.count);
  return counts[0]?.count ? (counts[0].delimiter as string) : ",";
}

export function parseCsv(input: string, delimiter = detectDelimiter(input)): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"' && field === "") quoted = true;
    else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

export type ColumnRole = "email" | "first_name" | "last_name" | "full_name" | "field" | "skip";

const HEADER_ROLES: [RegExp, ColumnRole][] = [
  [/^e ?mail( ?address)?$/, "email"],
  [/^(first ?name|given ?name|first|forename)$/, "first_name"],
  [/^(last ?name|family ?name|surname|last)$/, "last_name"],
  [/^(name|full ?name|contact ?name)$/, "full_name"],
];

export function guessColumnRole(header: string): ColumnRole {
  const normalized = header.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  for (const [pattern, role] of HEADER_ROLES) if (pattern.test(normalized)) return role;
  return "field";
}

// "Ada Lovelace" becomes first "Ada" and last "Lovelace".
export function splitFullName(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] ?? "", last: parts.slice(1).join(" ") };
}
