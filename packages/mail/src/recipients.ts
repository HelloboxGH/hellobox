export interface RecipientSuggestion {
  address: string;
  name: string | null;
  contact: boolean;
}

// Contacts come first, then the people this workspace has written to, most often first.
// Each address appears once, and a contact's name wins over one seen on an old email.
export function mergeSuggestions(
  contactRows: { email: string; firstName: string | null; lastName: string | null }[],
  sent: { address: string; name: string | null }[],
  exclude: string[] = [],
  limit = 8,
): RecipientSuggestion[] {
  const seen = new Set(exclude.map((address) => address.toLowerCase()));
  const out: RecipientSuggestion[] = [];
  const add = (suggestion: RecipientSuggestion) => {
    const key = suggestion.address.toLowerCase();
    if (seen.has(key) || out.length >= limit) return;
    seen.add(key);
    out.push({ ...suggestion, address: key });
  };
  for (const row of contactRows) {
    const name = [row.firstName, row.lastName].filter(Boolean).join(" ").trim();
    add({ address: row.email, name: name || null, contact: true });
  }
  for (const row of sent) add({ address: row.address, name: row.name?.trim() || null, contact: false });
  return out;
}
