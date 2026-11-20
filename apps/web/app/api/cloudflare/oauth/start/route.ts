import { getExtensions } from "@/core/extensions";
import { getEnv, isCloudflareConfigured } from "@hellobox/config";
import { getDb, members } from "@hellobox/db";
import { buildCloudflareAuthorizeUrl } from "@hellobox/providers";
import { createPkce } from "@hellobox/resend";
import { and, eq } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { connection } from "next/server";
import { getAuth } from "@/core/auth";

export async function GET(request: Request) {
  // Runs per request, so the build never needs runtime env vars.
  await connection();
  const session = await getAuth().api.getSession({ headers: await headers() });
  const appUrl = getEnv().APP_URL;
  if (!session) return Response.redirect(`${appUrl}/login`);
  const refused = getExtensions().mail?.refuseRoute?.({ isAnonymous: session.user.isAnonymous }) ?? null;
  if (refused) return refused;
  if (!isCloudflareConfigured()) return new Response("Cloudflare isn't available on this server yet", { status: 404 });
  const params = new URL(request.url).searchParams;
  const workspaceId = params.get("workspace") ?? "";
  // The domain being set up, so the callback can go straight back to it.
  const domain = params.get("domain") ?? "";
  const back = /^[a-z0-9.-]{3,253}$/.test(domain) ? { connectionId: params.get("connection") ?? "", domain } : null;
  const [member] = await getDb()
    .select({ role: members.role })
    .from(members)
    .where(and(eq(members.userId, session.user.id), eq(members.workspaceId, workspaceId)));
  if (!member || member.role === "member") {
    return new Response("Only workspace admins can connect Cloudflare", { status: 403 });
  }

  const { verifier, challenge, state } = createPkce();
  (await cookies()).set("cloudflare_oauth", JSON.stringify({ verifier, state, workspaceId, back }), {
    httpOnly: true,
    sameSite: "lax",
    secure: appUrl.startsWith("https"),
    path: "/api/cloudflare/oauth",
    maxAge: 600,
  });
  return Response.redirect(
    buildCloudflareAuthorizeUrl({
      redirectUri: `${appUrl}/api/cloudflare/oauth/callback`,
      state,
      challenge,
    }),
  );
}
