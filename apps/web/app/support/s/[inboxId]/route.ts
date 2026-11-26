import "@/core/extensions";
import { getDb, supportInboxes } from "@hellobox/db";
import { eq } from "drizzle-orm";

// The hosted support page. Plain HTML, its script and styles from this site only, so the
// policy below can forbid everything else. Only the inbox's allowed sites may frame it.

async function allowedOrigins(inboxId: string) {
  if (!/^[\w-]{1,100}$/.test(inboxId)) return [];
  const [inbox] = await getDb()
    .select({ origins: supportInboxes.allowedOrigins })
    .from(supportInboxes)
    .where(eq(supportInboxes.id, inboxId));
  return inbox?.origins ?? [];
}

export const policy = (origins: string[]) =>
  [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    "connect-src 'self'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${origins.length ? origins.join(" ") : "'none'"}`,
  ].join("; ");

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>Support</title>
<link rel="stylesheet" href="/support/hosted.css">
<script src="/support/hosted.js" defer></script>
</head>
<body>
<main id="app" aria-live="polite"><p class="muted">Loading…</p></main>
<noscript><p>Turn on JavaScript to see your support conversations.</p></noscript>
</body>
</html>`;

export async function GET(_request: Request, { params }: { params: Promise<{ inboxId: string }> }) {
  const origins = await allowedOrigins((await params).inboxId);
  return new Response(PAGE, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": policy(origins),
      ...(origins.length ? {} : { "X-Frame-Options": "DENY" }),
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    },
  });
}
