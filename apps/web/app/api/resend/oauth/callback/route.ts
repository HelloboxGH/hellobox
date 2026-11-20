import { encrypt, getEnv } from "@hellobox/config";
import { getDb, members, connections } from "@hellobox/db";
import {
  clientForConnection,
  DELIVERY_EVENTS,
  syncDomains,
} from "@hellobox/mail";
import { enqueueBackfill } from "@hellobox/queue";
import { exchangeCode } from "@hellobox/resend";
import { and, eq } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { connection as awaitRequest } from "next/server";
import "@/core/extensions";
import { getAuth } from "@/core/auth";
import { entitlements } from "@/core/server/entitlements";

export async function GET(request: Request) {
  // Runs per request, so the build never needs runtime env vars.
  await awaitRequest();
  const appUrl = getEnv().APP_URL;
  const done = (status: string) =>
    Response.redirect(`${appUrl}/inbox?connect=${status}`);

  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) return Response.redirect(`${appUrl}/login`);

  const jar = await cookies();
  const raw = jar.get("resend_oauth")?.value;
  jar.delete({ name: "resend_oauth", path: "/api/resend/oauth" });
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (!raw || !code) return done("denied");
  const pending = JSON.parse(raw) as {
    verifier: string;
    state: string;
    workspaceId: string;
  };
  if (url.searchParams.get("state") !== pending.state) return done("denied");

  const db = getDb();
  const [row] = await db
    .select({ role: members.role })
    .from(members)
    .where(
      and(
        eq(members.userId, session.user.id),
        eq(members.workspaceId, pending.workspaceId),
      ),
    );
  if (!row || row.role === "member") return done("forbidden");

  let tokens: Awaited<ReturnType<typeof exchangeCode>>;
  try {
    tokens = await exchangeCode({
      code,
      redirectUri: `${appUrl}/api/resend/oauth/callback`,
      verifier: pending.verifier,
    });
  } catch {
    return done("failed");
  }

  // Reconnecting reuses the Resend row, which keeps its domains, mailboxes and webhook URL.
  const [existing] = await db
    .select({ id: connections.id, webhookId: connections.webhookId })
    .from(connections)
    .where(and(eq(connections.workspaceId, pending.workspaceId), eq(connections.provider, "resend")))
    .limit(1);
  const values = {
    accessTokenEnc: encrypt(tokens.accessToken),
    refreshTokenEnc: encrypt(tokens.refreshToken),
    accessExpiresAt: tokens.expiresAt,
    scope: tokens.scope,
    status: "active" as const,
  };
  const [connection] = existing
    ? await db
        .update(connections)
        .set(values)
        .where(eq(connections.id, existing.id))
        .returning({ id: connections.id })
    : await db
        .insert(connections)
        .values({ ...values, workspaceId: pending.workspaceId })
        .returning({ id: connections.id });
  if (!connection) return done("failed");

  const client = clientForConnection(connection.id);
  try {
    await syncDomains(connection.id, pending.workspaceId, (await entitlements(pending.workspaceId)).limits.domains);
  } catch {
    return done("failed");
  }
  if (existing?.webhookId) {
    await client.deleteWebhook(existing.webhookId).catch(() => undefined);
  }
  await enqueueBackfill(connection.id).catch(() => undefined);
  try {
    const webhook = await client.createWebhook(
      `${appUrl}/api/webhooks/resend/${connection.id}`,
      ["email.received", "contact.updated", ...DELIVERY_EVENTS],
    );
    await db
      .update(connections)
      .set({
        webhookId: webhook.id,
        webhookSecretEnc: encrypt(webhook.signing_secret),
      })
      .where(eq(connections.id, connection.id));
  } catch {
    // Local URLs can't receive webhooks. The backfill job still brings mail in.
    return done("no-webhook");
  }
  return done("ok");
}
