#!/usr/bin/env bun
// Builds the site's content from the docs people read on GitHub, so there's one source:
// every Markdown file in the public `docs/` folder (subfolders included), CONTRIBUTING.md,
// and a settings reference made from .env.example.
//
// - Each page gets its title (the `# heading`) and description (the first paragraph) as
//   frontmatter.
// - Links between the files become links between pages; links to anything else in the repo
//   go to GitHub. A link to .env.example goes to the settings reference.
// - A folder is a section of the sidebar. Its README.md is the section's first page, and the
//   order of the links in that README is the order of the pages.
//
// Runs before dev, build and typecheck; the output (content/) isn't committed.
//
//   bun scripts/content.ts

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";

export const REPO_URL = "https://github.com/HelloboxGH/hellobox";
/** The settings reference made from .env.example. */
export const SETTINGS_SLUG = "self-hosting/settings";

/** A page: where its source lives in the public repo, and its address on the site ("" is the home page). */
export type Page = { path: string; slug: string };

const ROOT = join(import.meta.dir, "..", "..", "..");
const OUT = join(import.meta.dir, "..", "content");

/** The public docs folder: `docs/public` here (it becomes `docs` when exported), `docs` in the public repo. */
function docsFolder() {
  return existsSync(join(ROOT, "docs", "public", "README.md")) ? join(ROOT, "docs", "public") : join(ROOT, "docs");
}

/** Every Markdown file under `dir`, as paths relative to it. */
function markdownFiles(dir: string, prefix = ""): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return markdownFiles(path, `${prefix}${name}/`);
      return name.endsWith(".md") ? [`${prefix}${name}`] : [];
    });
}

/** A docs file's address: `self-hosting/README.md` is `self-hosting`, `install.md` is `install`. */
export function slugOf(file: string) {
  const path = file.replace(/\.md$/, "").toLowerCase();
  if (path === "readme") return "";
  return path.endsWith("/readme") ? path.slice(0, -"/readme".length) : path;
}

/** Every page, in public-repo paths. `docsFiles` are relative to the docs folder. */
export function pagesFrom(docsFiles: string[]): Page[] {
  const docs = docsFiles.filter((file) => file.endsWith(".md")).map((file) => ({ path: `docs/${file}`, slug: slugOf(file) }));
  return [...docs, { path: "CONTRIBUTING.md", slug: "contributing" }, { path: ".env.example", slug: SETTINGS_SLUG }];
}

/** A link target from `from` (a public path), as a site URL or a GitHub URL. */
export function resolveLink(target: string, from: string, pages: Page[]): string {
  if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target)) return target;
  const hash = target.indexOf("#");
  const path = hash === -1 ? target : target.slice(0, hash);
  const anchor = hash === -1 ? "" : target.slice(hash);
  const resolved = posix
    .normalize(posix.join(posix.dirname(from), path))
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
  const page = pages.find((p) => p.path === resolved || p.path === `${resolved}/README.md`);
  if (page) return `/${page.slug}${anchor}`;
  return `${REPO_URL}/blob/main/${resolved}${anchor}`;
}

/** Plain text of a Markdown paragraph, for the description. */
function plain(markdown: string) {
  return markdown
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The link targets in `markdown` outside code blocks, in order. */
function linkTargets(markdown: string) {
  let fenced = false;
  return markdown.split("\n").flatMap((line) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    return fenced ? [] : [...line.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]!);
  });
}

function frontmatter(title: string, description: string) {
  const lines = [`title: ${JSON.stringify(title)}`, ...(description ? [`description: ${JSON.stringify(description)}`] : [])];
  return `---\n${lines.join("\n")}\n---\n`;
}

/** One file, as the site's page: frontmatter, then the body without its title, links rewritten. */
export function toPage(markdown: string, from: string, pages: Page[]): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const titleAt = lines.findIndex((line) => /^# /.test(line));
  if (titleAt === -1) throw new Error(`${from} has no "# Title" line.`);
  const title = lines[titleAt]!.slice(2).trim();
  const body = lines.slice(titleAt + 1);

  // The first paragraph: lines up to a blank line, skipping blanks before it.
  const start = body.findIndex((line) => line.trim() !== "");
  const end = body.findIndex((line, i) => i > start && line.trim() === "");
  const first = start === -1 ? "" : body.slice(start, end === -1 ? undefined : end).join(" ");
  const description = /^[#>|`\-*\d]/.test(first.trim()) ? "" : plain(first);

  let fenced = false;
  const rewritten = body.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) return line;
    return line.replace(/\]\(([^)\s]+)\)/g, (_, target: string) => `](${resolveLink(target, from, pages)})`);
  });

  return `${frontmatter(title, description)}${rewritten.join("\n").replace(/^\n+/, "\n")}`;
}

/** Inline code for example values and commands in a comment. */
function codeValues(text: string) {
  return text
    .replace(/\b(Example|Examples|Generate|Generate each): (.+)$/, (_, label: string, value: string) => `${label}: \`${value.trim()}\``)
    .replace(/^(Required|Optional)\b(\s+for development)?\./, (match) => `**${match}**`);
}

/**
 * The settings reference: every variable in .env.example with its comment, under the
 * file's own `# ── Section ──` headings.
 */
export function settingsPage(env: string, from = ".env.example", pages: Page[] = []): string {
  const out: string[] = [];
  let comment: string[] = [];
  let vars: { name: string; value: string }[] = [];
  // The file's own header (how to copy it) is for people reading the file; skip it.
  let inHeader = true;

  const flush = () => {
    if (vars.length) {
      out.push(`### ${vars.map((v) => `\`${v.name}\``).join(", ")}`, "");
      if (comment.length) out.push(codeValues(comment.join(" ")), "");
      const defaults = vars.filter((v) => v.value);
      if (defaults.length) {
        out.push(`In \`.env.example\`: ${defaults.map((v) => `\`${v.name}=${v.value}\``).join(", ")}`, "");
      }
    } else if (comment.length) {
      out.push(codeValues(comment.join(" ")), "");
    }
    comment = [];
    vars = [];
  };

  for (const raw of env.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    const section = /^# ── (.+?) ─+$/.exec(line);
    const variable = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (section) {
      inHeader = false;
      flush();
      out.push(`## ${section[1]}`, "");
    } else if (inHeader) {
      continue;
    } else if (variable) {
      vars.push({ name: variable[1]!, value: variable[2]!.replace(/^"(.*)"$/, "$1") });
    } else if (line.startsWith("#")) {
      // A comment after a variable starts the next entry.
      if (vars.length) flush();
      comment.push(line.replace(/^#\s?/, ""));
    } else if (line === "") {
      flush();
    }
  }
  flush();

  const intro = [
    "Every setting HelloBox reads, from the `.env` file next to `compose.yml`. This page is made",
    "from [.env.example](https://github.com/HelloboxGH/hellobox/blob/main/.env.example), so it always",
    "matches the version on GitHub. After you change `.env`, run `docker compose up -d` to apply it.",
    "",
    "**Required** settings must be set. Leave an optional one empty to switch its feature off.",
  ];
  return toPage(["# All settings", "", ...intro, "", ...out].join("\n"), from, pages);
}

/**
 * The sidebar order of a folder: its README first, then its pages in the order its README
 * links to them, then any it doesn't link to, alphabetically.
 */
export function folderMeta(folder: string, readme: string | undefined, pages: Page[]) {
  const childOf = (slug: string) => (folder ? slug.startsWith(`${folder}/`) : slug !== "") && slug !== folder;
  const name = (slug: string) => (folder ? slug.slice(folder.length + 1) : slug).split("/")[0]!;
  const children = [...new Set(pages.filter((p) => childOf(p.slug)).map((p) => name(p.slug)))];
  const readmePath = folder ? `docs/${folder}/README.md` : "docs/README.md";
  const linked = readme
    ? linkTargets(readme)
        .map((target) => resolveLink(target, readmePath, pages))
        .filter((url) => url.startsWith("/") && childOf(url.slice(1).split("#")[0]!))
        .map((url) => name(url.slice(1).split("#")[0]!))
    : [];
  const order = [...new Set([...linked, ...children.sort()])].filter((n) => children.includes(n));
  const title = readme ? /^# (.+)$/m.exec(readme)?.[1]?.trim() : undefined;
  return { ...(folder && title ? { title } : {}), pages: ["index", ...order] };
}

/** Where a page's file goes in content/. */
function outFile(page: Page, folders: Set<string>) {
  if (page.slug === "") return "index.md";
  return folders.has(page.slug) ? `${page.slug}/index.md` : `${page.slug}.md`;
}

function main() {
  const docs = docsFolder();
  const files = markdownFiles(docs);
  const pages = pagesFrom(files);
  const folders = new Set(pages.flatMap((p) => p.slug.split("/").slice(0, -1).map((_, i, all) => all.slice(0, i + 1).join("/"))));
  for (const p of pages) if (p.path.endsWith("/README.md")) folders.add(p.slug);

  rmSync(OUT, { recursive: true, force: true });
  for (const page of pages) {
    const file = join(OUT, outFile(page, folders));
    mkdirSync(dirname(file), { recursive: true });
    const source =
      page.path === "CONTRIBUTING.md" || page.path === ".env.example"
        ? join(ROOT, page.path)
        : join(docs, page.path.slice("docs/".length));
    const text = readFileSync(source, "utf8");
    writeFileSync(file, page.path === ".env.example" ? settingsPage(text, page.path, pages) : toPage(text, page.path, pages));
  }
  for (const folder of ["", ...folders]) {
    const readmeFile = join(docs, folder, "README.md");
    const readme = existsSync(readmeFile) ? readFileSync(readmeFile, "utf8") : undefined;
    mkdirSync(join(OUT, folder), { recursive: true });
    writeFileSync(join(OUT, folder, "meta.json"), `${JSON.stringify(folderMeta(folder, readme, pages), null, 2)}\n`);
  }
  console.log(`docs content: ${pages.length} pages`);
}

if (import.meta.main) main();
