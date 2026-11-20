import { getEnv } from "@hellobox/config";
import { getDb, members } from "@hellobox/db";
import { addChannel, latestChannels } from "@hellobox/mail";
import { and, eq } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { connection } from "next/server";
import { getAuth } from "@/core/auth";
import { exchangeCode, isOAuthProvider } from "@/core/server/notification-oauth";

export async function GET(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  // Runs per request, so the build never needs runtime env vars.
  await connection();
  const { provider } = await params;
  const appUrl = getEnv().APP_URL;
  let from = "settings";
  const done = (status: string) =>
    Response.redirect(
      from === "onboarding"
        ? `${appUrl}/onboarding?${new URLSearchParams({ step: "notifications", connected: provider, status })}`
        : `${appUrl}/settings?${new URLSearchParams({ tab: "notifications", connected: provider, status })}`,
    );
  if (!isOAuthProvider(provider)) return new Response("Not found", { status: 404 });

  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) return Response.redirect(`${appUrl}/login`);
  const jar = await cookies();
  const raw = jar.get(`notify_oauth_${provider}`)?.value;
  jar.delete({ name: `notify_oauth_${provider}`, path: `/api/notifications/oauth/${provider}` });
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (!raw || !code) return done("denied");
  const pending = JSON.parse(raw) as { state: string; workspaceId: string; from?: string };
  if (pending.from === "onboarding") from = "onboarding";
  if (url.searchParams.get("state") !== pending.state) return done("denied");

  const [member] = await getDb()
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.userId, session.user.id), eq(members.workspaceId, pending.workspaceId)));
  if (!member) return done("forbidden");
  if ((await latestChannels(pending.workspaceId, session.user.id)).length >= 20) return done("full");

  try {
    const hook = await exchangeCode(provider, code);
    await addChannel({
      workspaceId: pending.workspaceId,
      userId: session.user.id,
      label: hook.label,
      config: { kind: provider, url: hook.url },
      preview: true,
    });
  } catch (error) {
    console.error(`[notifications] ${provider} connect failed:`, error);
    return done("failed");
  }
  return done("connected");
}
