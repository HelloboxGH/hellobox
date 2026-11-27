import { getEnv } from "@hellobox/config";
import { getDb, members } from "@hellobox/db";
import { emitEvent } from "@hellobox/extensions";
import { saveCloudflareGrant } from "@hellobox/mail";
import { exchangeCloudflareCode } from "@hellobox/providers";
import { and, eq } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { connection } from "next/server";
import { getAuth } from "@/core/auth";

export async function GET(request: Request) {
  // Runs per request, so the build never needs runtime env vars.
  await connection();
  const appUrl = getEnv().APP_URL;
  let back: { connectionId: string; domain: string; receive?: boolean } | null = null;
  const done = (status: string) => {
    const query = new URLSearchParams({ tab: "connection", cloudflare: status });
    if (back && status === "connected") {
      query.set("ses", back.connectionId);
      query.set(back.receive ? "receive" : "dns", back.domain);
    }
    return Response.redirect(`${appUrl}/settings?${query}`);
  };

  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) return Response.redirect(`${appUrl}/login`);

  const jar = await cookies();
  const raw = jar.get("cloudflare_oauth")?.value;
  jar.delete({ name: "cloudflare_oauth", path: "/api/cloudflare/oauth" });
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (!raw || !code) return done("denied");
  const pending = JSON.parse(raw) as { verifier: string; state: string; workspaceId: string; back?: typeof back };
  back = pending.back ?? null;
  if (url.searchParams.get("state") !== pending.state) return done("denied");

  const db = getDb();
  const [member] = await db
    .select({ role: members.role })
    .from(members)
    .where(and(eq(members.userId, session.user.id), eq(members.workspaceId, pending.workspaceId)));
  if (!member || member.role === "member") return done("forbidden");

  try {
    const tokens = await exchangeCloudflareCode({
      code,
      redirectUri: `${appUrl}/api/cloudflare/oauth/callback`,
      verifier: pending.verifier,
    });
    await saveCloudflareGrant(pending.workspaceId, tokens);
  } catch {
    return done("failed");
  }
  await emitEvent({ name: "connection.cloudflare_connected", workspaceId: pending.workspaceId, userId: session.user.id });
  return done("connected");
}
