import { decrypt, encrypt, getEnv } from "@hellobox/config";
import { connections, domains, getDb, webhookEvents } from "@hellobox/db";
import {
  detectMailgunRegion,
  isMailgunUrl,
  MailgunApi,
  mailgunDeliveryType,
  mailgunEventDetail,
  mailgunInboundId,
  verifyMailgunSignature,
  MAILGUN_MAX_AGE_SECONDS,
  type MailgunEventData,
  type MailgunRegion,
  type MailgunSignature,
} from "@hellobox/providers";
import { and, eq } from "drizzle-orm";
import Redis from "ioredis";
import { cloudflareStatus } from "./cloudflare";
import { loadConnection, mailgunProviderFor, markIfRoleRevoked, syncDomains } from "./connections";
import { receivePushedEmail } from "./pushed";
import { recordDeliveryEvent } from "./send";
import { importAddedDomain, normalizeDomain, domainLimitFor, withDns, type DnsHost } from "./ses";

const appUrl = () => getEnv().APP_URL.replace(/\/$/, "");

export const mailgunWebhookUrl = (connectionId: string, kind: "inbound" | "events") =>
  `${appUrl()}/api/webhooks/mailgun/${connectionId}/${kind}`;

// Connecting

// Checks the key, finds the region and saves the connection, then adds the event webhook
// and imports the domains. When the region can't be told from the domains, nothing is
// saved and the person is asked. Given an existing connection, it reconnects that one.
export async function connectMailgun(input: {
  workspaceId: string;
  apiKey: string;
  signingKey: string;
  region?: MailgunRegion;
  connectionId?: string;
}): Promise<{ needsRegion: true } | { needsRegion: false; connectionId: string; region: MailgunRegion }> {
  const db = getDb();
  const region = input.region ?? (await detectMailgunRegion(input.apiKey));
  if (!region) return { needsRegion: true };
  // Checks the key in the chosen region, even when it was picked by hand.
  await new MailgunApi(input.apiKey, region).listDomains();

  let previous: Awaited<ReturnType<typeof loadConnection>> | undefined;
  if (input.connectionId) {
    previous = await loadConnection(input.connectionId).catch(() => undefined);
    if (!previous || previous.workspaceId !== input.workspaceId || previous.provider !== "mailgun") {
      throw new Error("Mailgun connection not found");
    }
  }
  // Routes stay with the connection when it's the same region; a new region starts over.
  const routes = previous?.config.mailgun?.region === region ? previous.config.mailgun.routes : {};
  const values = {
    status: "pending" as const,
    config: { mailgun: { region, routes } },
    accessTokenEnc: encrypt(input.apiKey),
    webhookSecretEnc: encrypt(input.signingKey),
  };
  let connectionId: string;
  if (previous) {
    await db.update(connections).set(values).where(eq(connections.id, previous.id));
    connectionId = previous.id;
  } else {
    const [row] = await db
      .insert(connections)
      .values({ workspaceId: input.workspaceId, provider: "mailgun", ...values })
      .returning({ id: connections.id });
    if (!row) throw new Error("Couldn't save the connection");
    connectionId = row.id;
  }

  const provider = mailgunProviderFor(await loadConnection(connectionId));
  if (previous?.webhookId) await provider.deleteEventsWebhook(previous.webhookId).catch(() => undefined);
  const webhookId = await provider.createEventsWebhook(mailgunWebhookUrl(connectionId, "events"));
  await db.update(connections).set({ status: "active", webhookId }).where(eq(connections.id, connectionId));
  await syncDomains(connectionId, input.workspaceId, await domainLimitFor(input.workspaceId));
  return { needsRegion: false, connectionId, region };
}

async function activeMailgun(connectionId: string, workspaceId: string) {
  const connection = await loadConnection(connectionId);
  if (connection.workspaceId !== workspaceId || connection.provider !== "mailgun") {
    throw new Error("Mailgun connection not found");
  }
  if (connection.status !== "active") throw new Error("This Mailgun connection isn't active. Reconnect it first.");
  return { connection, provider: mailgunProviderFor(connection) };
}

// Calls Mailgun, and marks the connection when the key stopped working.
async function guarded<T>(connectionId: string, work: () => Promise<T>) {
  try {
    return await work();
  } catch (error) {
    await markIfRoleRevoked(connectionId, error);
    throw error;
  }
}

// Domains

export async function addMailgunDomain(connectionId: string, workspaceId: string, name: string) {
  const { connection, provider } = await activeMailgun(connectionId, workspaceId);
  const domain = normalizeDomain(name);
  const records = await guarded(connectionId, () => provider.addDomain(domain));
  const setup = await withDns(connection, null, domain, records);
  await importAddedDomain(connectionId, workspaceId, domain);
  return setup;
}

export async function mailgunDomainSetup(connectionId: string, workspaceId: string, domain: string) {
  const { provider } = await activeMailgun(connectionId, workspaceId);
  const [records, cloudflare] = await Promise.all([
    guarded(connectionId, () => provider.domainRecords(domain)),
    cloudflareStatus(workspaceId, domain),
  ]);
  return { records, zoneFound: null, cloudflare };
}

export async function applyMailgunDomainDns(connectionId: string, workspaceId: string, domain: string, host: DnsHost) {
  const { connection, provider } = await activeMailgun(connectionId, workspaceId);
  return withDns(connection, null, domain, await guarded(connectionId, () => provider.domainRecords(domain)), host);
}

// Receiving

// One route per receiving domain, which stores mail and tells our webhook. Turning a
// domain off deletes its route. Returns the MX records' setup for a domain turned on.
export async function setMailgunReceiving(connectionId: string, workspaceId: string, domain: string, on: boolean) {
  const db = getDb();
  const { connection, provider } = await activeMailgun(connectionId, workspaceId);
  const [owned] = await db
    .select({ id: domains.id })
    .from(domains)
    .where(and(eq(domains.connectionId, connectionId), eq(domains.name, domain)));
  if (!owned) throw new Error("That domain isn't part of this connection");
  const mailgun = connection.config.mailgun!;
  const routes = { ...mailgun.routes };
  if (on && !routes[domain]) {
    routes[domain] = await guarded(connectionId, () => provider.createRoute(domain, mailgunWebhookUrl(connectionId, "inbound")));
  }
  if (!on && routes[domain]) {
    await guarded(connectionId, () => provider.deleteRoute(routes[domain]!));
    delete routes[domain];
  }
  provider.target.routes = routes;
  await db
    .update(connections)
    .set({ config: { ...connection.config, mailgun: { ...mailgun, routes } } })
    .where(eq(connections.id, connectionId));
  await syncDomains(connectionId, workspaceId, await domainLimitFor(workspaceId));
  if (!on) return { mx: null };
  const records = (await provider.domainRecords(domain)).filter((record) => record.type === "MX");
  return { mx: await withDns(connection, null, domain, records) };
}

// Webhooks

type WebhookResult = { status: number };

let redis: Redis | undefined;

interface WebhookSteps {
  // The connection's workspace and signing key, or null when there's no such Mailgun
  // connection.
  load(connectionId: string): Promise<{ workspaceId: string; signingKey: string } | null>;
  // Whether a signature's token was already used, and remembering one once handled.
  seen(token: string): Promise<boolean>;
  remember(token: string): Promise<void>;
  fetchRaw(connectionId: string, storageUrl: string): Promise<Uint8Array>;
  receive: typeof receivePushedEmail;
  recordEvent(connectionId: string, providerEventId: string, type: string, messageId: string, event: MailgunEventData): Promise<void>;
}

const tokenKey = (token: string) => `mailgun-token:${token}`;

const webhookSteps: WebhookSteps = {
  load: async (connectionId) => {
    const connection = await loadConnection(connectionId).catch(() => null);
    if (!connection || connection.provider !== "mailgun" || !connection.webhookSecretEnc) return null;
    return { workspaceId: connection.workspaceId, signingKey: decrypt(connection.webhookSecretEnc) };
  },
  seen: async (token) => {
    redis ??= new Redis(getEnv().REDIS_URL);
    return (await redis.exists(tokenKey(token))) === 1;
  },
  remember: async (token) => {
    redis ??= new Redis(getEnv().REDIS_URL);
    // Kept a little longer than a signature stays valid.
    await redis.set(tokenKey(token), "1", "EX", MAILGUN_MAX_AGE_SECONDS * 2);
  },
  fetchRaw: async (connectionId, storageUrl) => {
    const provider = mailgunProviderFor(await loadConnection(connectionId));
    return guarded(connectionId, () => provider.fetchRaw(storageUrl));
  },
  receive: receivePushedEmail,
  recordEvent: async (connectionId, providerEventId, type, messageId, event) => {
    await getDb()
      .insert(webhookEvents)
      .values({ connectionId, providerEventId, type, emailId: messageId, payload: event })
      .onConflictDoNothing();
    await recordDeliveryEvent(connectionId, type, messageId, mailgunEventDetail(event));
  },
};

// A valid, recent signature whose token we haven't handled yet. Tokens are remembered
// only after the work is done, so a retry after a failure still gets through.
async function verified(steps: WebhookSteps, connectionId: string, signature: Partial<MailgunSignature>, now: number) {
  const connection = await steps.load(connectionId);
  if (!connection) return { status: 404 as const };
  if (!verifyMailgunSignature(signature, connection.signingKey, now)) return { status: 401 as const };
  if (await steps.seen(signature.token!)) return { status: 200 as const, replay: true };
  return { status: 0 as const, connection };
}

// A route stored new mail. Mailgun keeps it for 3 days; we fetch the raw message now and
// store our own copy before answering 200. Anything that throws becomes a 500, and
// Mailgun tries again for 8 hours.
export async function handleMailgunInbound(
  connectionId: string,
  fields: Record<string, string>,
  steps: WebhookSteps = webhookSteps,
  now = Date.now(),
): Promise<WebhookResult> {
  const check = await verified(steps, connectionId, fields, now);
  if (!check.connection) return { status: check.status };
  const storageUrl = fields["message-url"];
  if (!storageUrl || !isMailgunUrl(storageUrl)) return { status: 400 };
  const emailId = mailgunInboundId(storageUrl);
  await steps.receive({
    connectionId,
    workspaceId: check.connection.workspaceId,
    emailId,
    providerEventId: `inbound:${emailId}`,
    raw: await steps.fetchRaw(connectionId, storageUrl),
    hint: { recipients: fields.recipient ? [fields.recipient.toLowerCase()] : [] },
    payload: { from: fields.from ?? null, subject: fields.subject ?? null },
  });
  await steps.remember(fields.token!);
  return { status: 200 };
}

// Delivery, failure and complaint events. Anything else signed gets a 200 and is ignored.
export async function handleMailgunEvent(
  connectionId: string,
  body: { signature?: Partial<MailgunSignature>; "event-data"?: MailgunEventData },
  steps: WebhookSteps = webhookSteps,
  now = Date.now(),
): Promise<WebhookResult> {
  const signature = body.signature ?? {};
  const check = await verified(steps, connectionId, signature, now);
  if (!check.connection) return { status: check.status };
  const event = body["event-data"] ?? {};
  const type = mailgunDeliveryType(event);
  const messageId = event.message?.headers?.["message-id"]?.replace(/^<|>$/g, "");
  if (type && messageId) {
    await steps.recordEvent(connectionId, event.id ?? `${type}:${messageId}`, type, messageId, event);
  }
  await steps.remember(signature.token!);
  return { status: 200 };
}
