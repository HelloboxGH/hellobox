import "@/core/extensions";
import { getDb, supportInboxes } from "@hellobox/db";
import { eq } from "drizzle-orm";
import { page, pageResponse } from "@/core/server/support-api/page";

// The hosted support page, where a signed-in customer sees their conversations.

async function allowedOrigins(inboxId: string) {
  if (!/^[\w-]{1,100}$/.test(inboxId)) return [];
  const [inbox] = await getDb()
    .select({ origins: supportInboxes.allowedOrigins })
    .from(supportInboxes)
    .where(eq(supportInboxes.id, inboxId));
  return inbox?.origins ?? [];
}

const PAGE = page({ title: "Support", script: "/support/hosted.js", noscript: "Turn on JavaScript to see your support conversations." });

export async function GET(_request: Request, { params }: { params: Promise<{ inboxId: string }> }) {
  return pageResponse(PAGE, await allowedOrigins((await params).inboxId));
}
