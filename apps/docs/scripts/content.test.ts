import { describe, expect, test } from "bun:test";
import { folderMeta, pagesFrom, REPO_URL, resolveLink, SETTINGS_SLUG, settingsPage, slugOf, toPage } from "./content";

const pages = pagesFrom(["README.md", "self-hosting/README.md", "self-hosting/install.md", "CONVENTIONS.md", "notes.txt"]);

describe("slugOf", () => {
  test("a README is its folder's page", () => {
    expect(slugOf("README.md")).toBe("");
    expect(slugOf("self-hosting/README.md")).toBe("self-hosting");
    expect(slugOf("self-hosting/install.md")).toBe("self-hosting/install");
    expect(slugOf("CONVENTIONS.md")).toBe("conventions");
  });
});

describe("pagesFrom", () => {
  test("maps docs files, CONTRIBUTING.md and .env.example to pages", () => {
    expect(pages).toEqual([
      { path: "docs/README.md", slug: "" },
      { path: "docs/self-hosting/README.md", slug: "self-hosting" },
      { path: "docs/self-hosting/install.md", slug: "self-hosting/install" },
      { path: "docs/CONVENTIONS.md", slug: "conventions" },
      { path: "CONTRIBUTING.md", slug: "contributing" },
      { path: ".env.example", slug: SETTINGS_SLUG },
    ]);
  });
});

describe("resolveLink", () => {
  test("links between pages become site links, anchors kept", () => {
    expect(resolveLink("install.md#start-hellobox", "docs/self-hosting/README.md", pages)).toBe("/self-hosting/install#start-hellobox");
    expect(resolveLink("../CONTRIBUTING.md", "docs/README.md", pages)).toBe("/contributing");
    expect(resolveLink("docs/CONVENTIONS.md", "CONTRIBUTING.md", pages)).toBe("/conventions");
    expect(resolveLink("../README.md", "docs/self-hosting/install.md", pages)).toBe("/");
  });

  test("a folder, or its README, is the folder's page", () => {
    expect(resolveLink("self-hosting/", "docs/README.md", pages)).toBe("/self-hosting");
    expect(resolveLink("self-hosting/README.md", "docs/README.md", pages)).toBe("/self-hosting");
    expect(resolveLink("docs/self-hosting/README.md", "README.md", pages)).toBe("/self-hosting");
  });

  test(".env.example is the settings page", () => {
    expect(resolveLink("../../.env.example", "docs/self-hosting/README.md", pages)).toBe(`/${SETTINGS_SLUG}`);
  });

  test("other repo files go to GitHub", () => {
    expect(resolveLink("LICENSE", "CONTRIBUTING.md", pages)).toBe(`${REPO_URL}/blob/main/LICENSE`);
    expect(resolveLink("../../packages/providers/src/types.ts", "docs/self-hosting/install.md", pages)).toBe(
      `${REPO_URL}/blob/main/packages/providers/src/types.ts`,
    );
  });

  test("leaves absolute links and anchors alone", () => {
    for (const link of ["https://bun.sh", "mailto:a@b.c", "#first-admin"]) expect(resolveLink(link, "CONTRIBUTING.md", pages)).toBe(link);
  });
});

describe("toPage", () => {
  test("title and description go to frontmatter; links are rewritten outside code", () => {
    const page = toPage(
      "# Install\n\nRun **HelloBox** on [your server](README.md).\nTwo lines.\n\n## Next\n\nSee [license](../../LICENSE).\n\n```md\n[keep](README.md)\n```\n",
      "docs/self-hosting/install.md",
      pages,
    );
    expect(page).toBe(
      `---\ntitle: "Install"\ndescription: "Run HelloBox on your server. Two lines."\n---\n\nRun **HelloBox** on [your server](/self-hosting).\nTwo lines.\n\n## Next\n\nSee [license](${REPO_URL}/blob/main/LICENSE).\n\n\`\`\`md\n[keep](README.md)\n\`\`\`\n`,
    );
  });

  test("no description when the page starts with a list", () => {
    expect(toPage("# Docs\n\n- [A](README.md)\n", "docs/README.md", pages)).toBe('---\ntitle: "Docs"\n---\n\n- [A](/)\n');
  });

  test("refuses a file without a title", () => {
    expect(() => toPage("no title\n", "docs/x.md", pages)).toThrow("has no");
  });
});

describe("settingsPage", () => {
  const env = [
    "# HelloBox settings.",
    "# Copy this file.",
    "",
    "# ── Core ──────────",
    "",
    "# Required. The public address.",
    "# Example: https://mail.example.com",
    "APP_URL=http://127.0.0.1:3010",
    "",
    "# Required. Passwords for the containers.",
    "# Generate each: openssl rand -hex 24",
    "POSTGRES_PASSWORD=",
    "REDIS_PASSWORD=",
    "",
    "# Bucket name.",
    "S3_BUCKET=hellobox",
    "# Access key.",
    "S3_ACCESS_KEY_ID=",
  ].join("\n");
  const page = settingsPage(env);

  test("skips the file's own header and keeps its sections", () => {
    expect(page).not.toContain("Copy this file");
    expect(page).toContain("## Core\n");
  });

  test("each variable gets its comment, with labels bold and values in code", () => {
    expect(page).toContain(
      "### `APP_URL`\n\n**Required.** The public address. Example: `https://mail.example.com`\n\nIn `.env.example`: `APP_URL=http://127.0.0.1:3010`",
    );
  });

  test("variables under one comment stay together", () => {
    expect(page).toContain("### `POSTGRES_PASSWORD`, `REDIS_PASSWORD`\n\n**Required.** Passwords for the containers. Generate each: `openssl rand -hex 24`");
  });

  test("a comment right after a variable starts the next entry", () => {
    expect(page).toContain("### `S3_BUCKET`\n\nBucket name.");
    expect(page).toContain("### `S3_ACCESS_KEY_ID`\n\nAccess key.");
  });
});

describe("folderMeta", () => {
  const all = pagesFrom([
    "README.md",
    "CONVENTIONS.md",
    "self-hosting/README.md",
    "self-hosting/install.md",
    "self-hosting/dns.md",
    "self-hosting/upgrade.md",
  ]);

  test("orders a folder by its README's links, then the rest alphabetically", () => {
    const readme = "# Self-hosting HelloBox\n\n1. [DNS](dns.md)\n2. [Install](install.md#start)\n\n```md\n[not this](upgrade.md)\n```\n";
    expect(folderMeta("self-hosting", readme, all)).toEqual({
      title: "Self-hosting HelloBox",
      pages: ["index", "dns", "install", "settings", "upgrade"],
    });
  });

  test("the top level lists folders and pages, without a title", () => {
    const readme = "# Docs\n\n- [Self-hosting](self-hosting/README.md)\n- [Contributing](../CONTRIBUTING.md)\n";
    expect(folderMeta("", readme, all)).toEqual({ pages: ["index", "self-hosting", "contributing", "conventions"] });
  });
});
