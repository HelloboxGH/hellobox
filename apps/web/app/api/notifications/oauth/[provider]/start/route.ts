import { getExtensions } from "@/core/extensions";
import { randomBytes } from "node:crypto";
import { getEnv } from "@hellobox/config";
import { getDb, members } from "@hellobox/db";
import { and, eq } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { connection } from "next/server";
import { getAuth } from "@/core/auth";
import { authorizeUrl, isOAuthProvider } from "@/core/server/notification-oauth";

export async function GET(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  // Runs per request, so the build never needs runtime env vars.
  await connection();
  const { provider } = await params;
  const appUrl = getEnv().APP_URL;
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) return Response.redirect(`${appUrl}/login`);
  const refused = getExtensions().mail?.refuseRoute?.({ isAnonymous: session.user.isAnonymous }) ?? null;
  if (refused) return refused;
  if (!isOAuthProvider(provider)) return new Response("Not found", { status: 404 });
  const query = new URL(request.url).searchParams;
  const workspaceId = query.get("workspace") ?? "";
  // Where to land afterwards: only these two pages, never a URL from the query.
  const from = query.get("from") === "onboarding" ? "onboarding" : "settings";
  const [member] = await getDb()
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.userId, session.user.id), eq(members.workspaceId, workspaceId)));
  if (!member) return new Response("You don't have access to this workspace", { status: 403 });

  const state = randomBytes(24).toString("base64url");
  const target = authorizeUrl(provider, state);
  if (!target) return new Response(`${provider} isn't available on this server yet`, { status: 404 });
  (await cookies()).set(`notify_oauth_${provider}`, JSON.stringify({ state, workspaceId, from }), {
    httpOnly: true,
    sameSite: "lax",
    secure: appUrl.startsWith("https"),
    path: `/api/notifications/oauth/${provider}`,
    maxAge: 600,
  });
  return Response.redirect(target);
}
