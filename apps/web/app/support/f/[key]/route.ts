import "@/core/extensions";
import { setting } from "@hellobox/config";
import { findSupportForm } from "@hellobox/mail";
import { page, pageResponse } from "@/core/server/support-api/page";

// The public support form. Anyone with the link can write; who they are isn't checked.

const PAGE = page({ title: "Contact us", script: "/support/form.js", noscript: "Turn on JavaScript to send a message." });

export async function GET(_request: Request, { params }: { params: Promise<{ key: string }> }) {
  const form = await findSupportForm((await params).key);
  if (!form) return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  return pageResponse(PAGE, form.inbox.allowedOrigins, Boolean(setting("TURNSTILE_SITE_KEY")));
}
