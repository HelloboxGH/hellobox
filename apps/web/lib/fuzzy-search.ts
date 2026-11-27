// A small search that forgives typos, for short lists of names (providers). Shared by the
// Connect a provider dialog and the public /providers page, so both find the same things.

// Lowercase, without accents, punctuation as spaces: "Mailgun (EU)" → "mailgun eu".
export function fold(text: string) {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Optimal string alignment: insertions, deletions, substitutions and swapping two
// neighbours ("sedngrid") each count as one edit.
export function editDistance(a: string, b: string) {
  if (a === b) return 0;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[a.length]![b.length]!;
}

// How many typos a query of this length may have: none under 3 letters, 1 up to 5, then 2.
export const allowedEdits = (length: number) => (length < 3 ? 0 : length <= 5 ? 1 : 2);

// The fewest edits between the query and the start of a word, so a half-typed query
// ("sengr") is compared with as much of the word ("sendg"), give or take a letter.
function prefixDistance(query: string, word: string) {
  if (word.length <= query.length) return editDistance(query, word);
  let best = Infinity;
  for (let length = Math.max(1, query.length - 1); length <= Math.min(word.length, query.length + 1); length++) {
    best = Math.min(best, editDistance(query, word.slice(0, length)));
  }
  return best;
}

// How well one text matches, from 0 (not at all) to 100 (the same).
function scoreText(query: string, text: string) {
  const folded = fold(text);
  if (!folded) return 0;
  const compactQuery = query.replace(/ /g, "");
  const compact = folded.replace(/ /g, "");
  if (compact === compactQuery) return 100;
  if (compact.startsWith(compactQuery)) return 90;
  const words = folded.split(" ");
  if (words.some((word) => word.startsWith(compactQuery))) return 80;
  // A near miss at the start of a word beats the query found in the middle of one
  // ("rsend" is Resend, not MailerSend).
  const allowed = allowedEdits(compactQuery.length);
  const distance = allowed ? Math.min(...[compact, ...words].map((word) => prefixDistance(compactQuery, word))) : Infinity;
  if (distance <= allowed) return 65 - distance * 10;
  return compact.includes(compactQuery) ? 40 : 0;
}

export interface SearchText {
  name: string;
  // Other names it goes by: "Sendinblue" for Brevo.
  aliases?: string[];
  // Matched last, and weaker: a category, a description.
  keywords?: string[];
}

export function searchScore(query: string, item: SearchText) {
  const folded = fold(query);
  if (!folded) return 0;
  return Math.max(
    scoreText(folded, item.name),
    ...(item.aliases ?? []).map((alias) => scoreText(folded, alias) - 5),
    ...(item.keywords ?? []).map((keyword) => (scoreText(folded, keyword) >= 80 ? scoreText(folded, keyword) - 50 : 0)),
  );
}

// The items that match, best first. Items that score the same keep their order, so the
// list's own order (featured first, say) breaks ties. An empty query returns them all.
export function fuzzySearch<T>(items: T[], query: string, text: (item: T) => SearchText): T[] {
  if (!fold(query)) return items;
  return items
    .map((item, index) => ({ item, index, score: Math.max(0, searchScore(query, text(item))) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
}
