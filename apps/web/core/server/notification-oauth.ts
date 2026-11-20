import { notificationEnv } from "@hellobox/mail";

// "Connect Discord" and "Add to Slack": the provider shows its own channel picker and hands
// back a webhook URL for that channel. No bot runs anywhere; sending is a plain POST after.

export type OAuthProvider = "discord" | "slack";

export const isOAuthProvider = (value: string): value is OAuthProvider => value === "discord" || value === "slack";

export const redirectUri = (provider: OAuthProvider) => `${notificationEnv().appUrl}/api/notifications/oauth/${provider}/callback`;

export function authorizeUrl(provider: OAuthProvider, state: string) {
  const env = notificationEnv();
  if (provider === "discord" && env.discord) {
    const query = new URLSearchParams({
      client_id: env.discord.id,
      response_type: "code",
      scope: "webhook.incoming",
      redirect_uri: redirectUri(provider),
      state,
    });
    return `https://discord.com/oauth2/authorize?${query}`;
  }
  if (provider === "slack" && env.slack) {
    const query = new URLSearchParams({
      client_id: env.slack.id,
      scope: "incoming-webhook",
      redirect_uri: redirectUri(provider),
      state,
    });
    return `https://slack.com/oauth/v2/authorize?${query}`;
  }
  return null;
}

/** Trades the code for the channel's webhook URL and a label people recognize. */
export async function exchangeCode(provider: OAuthProvider, code: string): Promise<{ url: string; label: string }> {
  const env = notificationEnv();
  if (provider === "discord" && env.discord) {
    const res = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.discord.id,
        client_secret: env.discord.secret,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri(provider),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as { webhook?: { url?: string; id?: string; token?: string; name?: string } };
    const hook = body.webhook;
    const url = hook?.url ?? (hook?.id && hook.token ? `https://discord.com/api/webhooks/${hook.id}/${hook.token}` : null);
    if (!res.ok || !url) throw new Error(`Discord didn't return a webhook (${res.status})`);
    return { url, label: "Discord channel" };
  }
  if (provider === "slack" && env.slack) {
    const res = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env.slack.id, client_secret: env.slack.secret, code, redirect_uri: redirectUri(provider) }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      team?: { name?: string };
      incoming_webhook?: { url?: string; channel?: string };
    };
    if (!body.ok || !body.incoming_webhook?.url) throw new Error("Slack didn't return a webhook");
    const where = [body.team?.name, body.incoming_webhook.channel].filter(Boolean).join(" ");
    return { url: body.incoming_webhook.url, label: `Slack · ${where || "channel"}` };
  }
  throw new Error(`${provider} isn't set up on this server`);
}
