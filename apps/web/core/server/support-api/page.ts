// The hosted support pages: plain HTML, with script and styles from this site only, so the
// policy can forbid everything else. Only an inbox's allowed sites may frame them.

const TURNSTILE = "https://challenges.cloudflare.com";

export const policy = (origins: string[], turnstile = false) =>
  [
    "default-src 'none'",
    `script-src 'self'${turnstile ? ` ${TURNSTILE}` : ""}`,
    "style-src 'self'",
    "img-src 'self'",
    "connect-src 'self'",
    ...(turnstile ? [`frame-src ${TURNSTILE}`] : []),
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${origins.length ? origins.join(" ") : "'none'"}`,
  ].join("; ");

export function page({ title, script, noscript }: { title: string; script: string; noscript: string }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>${title}</title>
<link rel="stylesheet" href="/support/hosted.css">
<script src="${script}" defer></script>
</head>
<body>
<main id="app" aria-live="polite"><p class="muted">Loading…</p></main>
<noscript><p>${noscript}</p></noscript>
</body>
</html>`;
}

export function pageResponse(html: string, origins: string[], turnstile = false) {
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": policy(origins, turnstile),
      ...(origins.length ? {} : { "X-Frame-Options": "DENY" }),
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    },
  });
}
