// A subdomain counts under its parent on the plan and is listed under it in settings.
// The parent is found among the workspace's own domains, so no public suffix list is
// needed: acme.co.uk never groups under co.uk, because nobody adds co.uk.

export const isSubdomainOf = (name: string, parent: string) => name.endsWith(`.${parent}`);

// The highest domain among these names that this one falls under, or itself.
export function rootDomain(name: string, names: Iterable<string>) {
  let root = name;
  for (const candidate of names) {
    if (isSubdomainOf(name, candidate) && candidate.length < root.length) root = candidate;
  }
  return root;
}

// Places these counted domains take on the plan: one per domain with its subdomains, and
// one for the same domain on two connections.
export function planDomainCount(names: string[]) {
  return new Set(names.map((name) => rootDomain(name, names))).size;
}

// Whether one more domain can be on. A subdomain of a domain that's already on is free,
// even when the plan is full.
export function fitsPlan(counted: string[], name: string, limit: number) {
  const next = planDomainCount([...counted, name]);
  return next <= limit || next <= planDomainCount(counted);
}

// The domains to turn off so the rest fit the plan, keeping the oldest places. A
// subdomain stays on with its parent.
export function overPlan<T extends { id: string; name: string }>(oldestFirst: T[], limit: number) {
  const names = oldestFirst.map((domain) => domain.name);
  const kept = new Set<string>();
  const extra: string[] = [];
  for (const domain of oldestFirst) {
    const root = rootDomain(domain.name, names);
    if (kept.has(root) || kept.size < limit) kept.add(root);
    else extra.push(domain.id);
  }
  return extra;
}

// Each domain followed by its subdomains, with the parent each one is listed under.
export function groupDomains<T extends { name: string }>(list: T[]) {
  const names = list.map((domain) => domain.name);
  return list
    .map((domain) => ({ domain, root: rootDomain(domain.name, names) }))
    .sort(
      (a, b) =>
        a.root.localeCompare(b.root) ||
        Number(a.domain.name !== a.root) - Number(b.domain.name !== b.root) ||
        a.domain.name.localeCompare(b.domain.name),
    )
    .map(({ domain, root }) => ({ domain, parent: root === domain.name ? null : root }));
}

// Why a name can't be the receiving subdomain for this parent, or null when it can.
export function subdomainProblem(parent: string, name: string) {
  if (name === parent) return `Use a subdomain, such as reply.${parent}, so ${parent}'s mail stays where it is`;
  if (!isSubdomainOf(name, parent)) return `Use a subdomain of ${parent}, such as reply.${parent}`;
  return null;
}
