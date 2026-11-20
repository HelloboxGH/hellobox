import { escapeHtml, formatBytes, formatFullTime } from "./types";

type Address = { address: string; name?: string };

export interface ExportMessage {
  id: string;
  fromName: string | null;
  fromAddress: string;
  toRecipients: Address[];
  ccRecipients: Address[];
  sentAt: string | Date;
  htmlBody: string | null;
  textBody: string | null;
  attachments: { filename: string; size: number }[];
}

// The bodies were sanitized at ingest. This only takes out what would reach a
// remote server: image sources and CSS url()s, quoted or entity-encoded.
export function blockRemoteImages(html: string) {
  return html
    .replace(/(<img\b[^>]*?\ssrc=)(["'])https?:[^"']*\2/gi, "$1$2$2")
    .replace(/url\(\s*(?:["']|&quot;|&#39;)?\s*https?:[^)]*\)/gi, "url()");
}

const person = (address: Address) =>
  address.name ? `${escapeHtml(address.name)} &lt;${escapeHtml(address.address)}&gt;` : escapeHtml(address.address);

function messageSection(message: ExportMessage, showImages: boolean) {
  const rows: [string, string][] = [
    ["From", person({ address: message.fromAddress, name: message.fromName ?? undefined })],
    ["To", message.toRecipients.map(person).join(", ")],
    ["Cc", message.ccRecipients.map(person).join(", ")],
    ["Date", escapeHtml(formatFullTime(message.sentAt))],
  ];
  const body = message.htmlBody
    ? `<div class="body">${showImages ? message.htmlBody : blockRemoteImages(message.htmlBody)}</div>`
    : `<div class="body text">${escapeHtml(message.textBody ?? "")}</div>`;
  const files = message.attachments.length
    ? `<ul class="files">${message.attachments
        .map((file) => `<li>${escapeHtml(file.filename)} <span>${formatBytes(file.size)}</span></li>`)
        .join("")}</ul>`
    : "";
  return `<article><dl>${rows
    .filter(([, value]) => value)
    .map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`)
    .join("")}</dl>${body}${files}</article>`;
}

// One self-contained page for the file download and for printing to PDF. No
// script can run in it, and remote images only load for messages where the
// reader already allowed them.
export function threadDocument<M extends ExportMessage>({
  subject, messages, origin, imagesShown,
}: {
  subject: string;
  messages: M[];
  // Where /api/attachments links resolve, so inline images still work outside the app.
  origin: string;
  imagesShown: (message: M) => boolean;
}) {
  const title = escapeHtml(subject || "(no subject)");
  const remote = messages.some((message) => message.htmlBody && imagesShown(message)) ? " https:" : "";
  const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src data: ${origin}${remote}; font-src data:`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><base href="${escapeHtml(origin)}/" target="_blank"><title>${title}</title><style>
:root{color-scheme:light}
body{margin:0 auto;max-width:760px;padding:32px 24px;font:14px/1.6 system-ui,sans-serif;color:#26262b;background:#fff;overflow-wrap:anywhere}
h1{margin:0 0 24px;font-size:22px;line-height:1.3}
article{padding:20px 0;border-top:1px solid #ddd}
dl{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;margin:0 0 16px;font-size:13px}
dt{color:#777}dd{margin:0}
.body img{max-width:100%;height:auto}.body table{max-width:100%}
.text{white-space:pre-wrap}
.files{margin:16px 0 0;padding:12px 0 0 18px;border-top:1px dashed #ddd;font-size:13px}.files span{color:#777}
blockquote{margin:8px 0;padding-left:12px;border-left:2px solid #ddd;color:#555}
a{color:#2b59c3}
@media print{body{max-width:none;padding:0}article{break-inside:auto}dl{break-inside:avoid}h1{margin-bottom:12px}}
@page{margin:16mm}
</style></head><body><h1>${title}</h1>${messages
    .map((message) => messageSection(message, imagesShown(message)))
    .join("")}</body></html>`;
}

export function exportFilename(subject: string, date: string | Date) {
  const stem = subject
    .replace(/^((re|fwd?|aw|tr)\s*:\s*)+/i, "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "")
    .toLowerCase();
  const day = new Date(date).toISOString().slice(0, 10);
  return `${stem || "conversation"}-${day}`;
}

export function downloadHtml(html: string, filename: string) {
  const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${filename}.html`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Prints from a hidden frame, so the person picks "Save as PDF" in the browser's
// own dialog. The frame can't run scripts; allow-modals is what lets it print.
export function printAsPdf(html: string, filename: string) {
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-same-origin allow-modals");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
  frame.srcdoc = html;
  // Browsers name the PDF after the top document's title.
  const title = document.title;
  const cleanup = () => {
    document.title = title;
    frame.remove();
  };
  frame.onload = async () => {
    const view = frame.contentWindow;
    if (!view) return cleanup();
    await Promise.all(
      [...view.document.images].map((image) =>
        image.complete ? null : new Promise((done) => { image.onload = image.onerror = done; })),
    );
    document.title = filename;
    view.addEventListener("afterprint", () => setTimeout(cleanup, 0), { once: true });
    view.focus();
    view.print();
  };
  document.body.append(frame);
}
