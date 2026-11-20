import { readdirSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { render } from "@react-email/render";
import type { ComponentType } from "react";
import * as emails from "./index";
import { SITE_URL } from "./layout";

type Template = ComponentType<object> & { PreviewProps: object };

const templates = (Object.entries(emails) as [string, unknown][]).filter(
  (entry): entry is [string, Template] => typeof entry[1] === "function" && "PreviewProps" in entry[1],
);

describe("templates", () => {
  // One export per file in templates/, so a new template can't be left out.
  test("every template is exported", () => {
    const files = readdirSync(new URL("./templates", import.meta.url)).filter((file) => file.endsWith(".tsx"));
    expect(templates.length).toBe(files.length);
  });

  for (const [name, Template] of templates) {
    test(`${name} renders HTML and plain text`, async () => {
      const element = <Template {...Template.PreviewProps} />;
      const html = await render(element);
      const text = await render(element, { plainText: true });
      expect(html).toContain(`${SITE_URL}/logo.png`);
      expect(text).toContain("HelloBox");
      expect(text).not.toContain("undefined");
    });
  }
});

describe("DomainClaim", () => {
  const cases: emails.DomainClaimEmail[] = [
    { kind: "notice", domain: "acme.com", workspace: "Acme", endsAt: new Date("2026-11-25T12:00:00Z") },
    { kind: "taken", domain: "acme.com", workspace: "Acme" },
    { kind: "access", domain: "acme.com", workspace: "Acme", requester: { name: "Bob", email: "bob@acme.com", workspace: "Acme new" } },
    { kind: "claimed", domain: "acme.com", enabled: true },
    { kind: "claimed", domain: "acme.com", enabled: false },
    ...(["kept", "active", "dns", "unverified"] as const).map((reason) => ({ kind: "stopped" as const, domain: "acme.com", reason })),
  ];
  for (const email of cases) {
    test(`${email.kind}${"reason" in email ? ` (${email.reason})` : ""} renders`, async () => {
      const text = await render(<emails.DomainClaim {...email} />, { plainText: true });
      expect(text).toContain("acme.com");
      expect(text).not.toContain("undefined");
      expect(emails.domainClaimSubject(email)).toContain("acme.com");
    });
  }
  test("the access request never names the holder to the asker, but names the asker to the holder", async () => {
    const text = await render(
      <emails.DomainClaim kind="access" domain="acme.com" workspace="Acme" requester={{ name: "Bob", email: "bob@acme.com", workspace: "Acme new" }} />,
      { plainText: true },
    );
    expect(text).toContain("bob@acme.com");
  });
});

describe("defaultReplyTo", () => {
  test("keeps the sender's username on the reply domain", () => {
    expect(emails.defaultReplyTo("HelloBox <hello@mail.example.com>", "example.com")).toBe("hello@example.com");
    expect(emails.defaultReplyTo("hello@mail.example.com", "@example.com")).toBe("hello@example.com");
  });
  test("is empty without a domain or a parsable sender", () => {
    expect(emails.defaultReplyTo("HelloBox <hello@mail.example.com>", "")).toBeUndefined();
    expect(emails.defaultReplyTo("nonsense", "example.com")).toBeUndefined();
  });
});
