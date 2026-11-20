import { describe, expect, test } from "bun:test";
import { blockRemoteImages, type ExportMessage, exportFilename, threadDocument } from "./export";

const message = (overrides: Partial<ExportMessage> = {}): ExportMessage => ({
  id: "m1",
  fromName: "Ada",
  fromAddress: "ada@example.com",
  toRecipients: [{ address: "team@acme.dev", name: "Team" }],
  ccRecipients: [],
  sentAt: "2026-11-09T10:00:00Z",
  htmlBody: null,
  textBody: "Hello",
  attachments: [],
  ...overrides,
});

const origin = "https://app.hellobox.test";

describe("blockRemoteImages", () => {
  test("drops remote image sources and CSS urls", () => {
    const html = `<img src="https://t.example/p.gif" alt="x"><div style="background:url(&quot;http://t.example/b.png&quot;)"></div><style>a{background:url('https://t.example/c.png')}</style>`;
    const out = blockRemoteImages(html);
    expect(out).not.toContain("t.example");
    expect(out).toContain(`<img src="" alt="x">`);
  });

  test("keeps inline attachments and data images", () => {
    const html = `<img src="/api/attachments/a1?inline=1"><img src="data:image/png;base64,AA==">`;
    expect(blockRemoteImages(html)).toBe(html);
  });
});

describe("threadDocument", () => {
  test("lists each message's headers, body and attachments", () => {
    const doc = threadDocument({
      subject: "Invoice <42>",
      origin,
      imagesShown: () => false,
      messages: [
        message({
          ccRecipients: [{ address: "cc@acme.dev" }],
          attachments: [{ filename: "invoice.pdf", size: 2048 }],
        }),
        message({ id: "m2", fromName: null, fromAddress: "bob@acme.dev", textBody: "a < b\nthanks" }),
      ],
    });
    expect(doc).toContain("<title>Invoice &lt;42&gt;</title>");
    expect(doc).toContain("Ada &lt;ada@example.com&gt;");
    expect(doc).toContain("Team &lt;team@acme.dev&gt;");
    expect(doc).toContain("<dt>Cc</dt><dd>cc@acme.dev</dd>");
    expect(doc.match(/<dt>Cc<\/dt>/g)).toHaveLength(1);
    expect(doc).toContain("invoice.pdf <span>2 KB</span>");
    expect(doc).toContain("a &lt; b\nthanks");
    expect(doc).not.toContain("<script");
  });

  test("keeps remote images blocked unless the reader allowed them", () => {
    const remote = `<p>Hi</p><img src="https://tracker.example/open.gif">`;
    const blocked = threadDocument({ subject: "S", origin, imagesShown: () => false, messages: [message({ htmlBody: remote })] });
    expect(blocked).not.toContain("tracker.example");
    expect(blocked).toContain(`img-src data: ${origin};`);

    const allowed = threadDocument({ subject: "S", origin, imagesShown: () => true, messages: [message({ htmlBody: remote })] });
    expect(allowed).toContain("tracker.example");
    expect(allowed).toContain(`img-src data: ${origin} https:;`);
  });

  test("only the allowed message keeps its images", () => {
    const doc = threadDocument({
      subject: "S",
      origin,
      imagesShown: (m) => m.id === "ok",
      messages: [
        message({ id: "ok", htmlBody: `<img src="https://cdn.ok.example/logo.png">` }),
        message({ id: "no", htmlBody: `<img src="https://tracker.example/open.gif">` }),
      ],
    });
    expect(doc).toContain("cdn.ok.example");
    expect(doc).not.toContain("tracker.example");
  });
});

describe("exportFilename", () => {
  test("uses the subject without reply prefixes, and the date", () => {
    expect(exportFilename("Re: Fwd: Q3 invoice / Acme", "2026-11-09T10:00:00Z")).toBe("q3-invoice-acme-2026-11-09");
  });

  test("keeps non-Latin letters and falls back when empty", () => {
    expect(exportFilename("Résumé für Zoë", "2026-01-02T00:00:00Z")).toBe("résumé-für-zoë-2026-01-02");
    expect(exportFilename("   ", "2026-01-02T00:00:00Z")).toBe("conversation-2026-01-02");
  });

  test("caps the length", () => {
    expect(exportFilename("a".repeat(200), "2026-01-02T00:00:00Z").length).toBeLessThanOrEqual(91);
  });
});
