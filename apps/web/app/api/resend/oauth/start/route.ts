import { getExtensions } from "@/core/extensions";
import { buildAuthorizeUrl, createPkce } from "@hellobox/resend";
import { getEnv } from "@hellobox/config";
import { and, eq } from "drizzle-orm";
import { getDb, members } from "@hellobox/db";
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
  const workspaceId = new URL(request.url).searchParams.get("workspace") ?? "";
  const [member] = await getDb()
    .select({ role: members.role })
    .from(members)
    .where(and(eq(members.userId, session.user.id), eq(members.workspaceId, workspaceId)));
  if (!member || member.role === "member") {
    return new Response("Only workspace admins can connect Resend", { status: 403 });
  }

  const { verifier, challenge, state } = createPkce();
  (await cookies()).set(
    "resend_oauth",
    JSON.stringify({ verifier, state, workspaceId }),
    {
      httpOnly: true,
      sameSite: "lax",
      secure: appUrl.startsWith("https"),
      path: "/api/resend/oauth",
      maxAge: 600,
    },
  );
  return Response.redirect(
    buildAuthorizeUrl({
      redirectUri: `${appUrl}/api/resend/oauth/callback`,
      state,
      challenge,
    }),
  );
}
