import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { decrypt, encrypt, getEnv } from "@hellobox/config";
import { connections, domains, getDb, webhookEvents } from "@hellobox/db";
import {
  BrevoError,
  BrevoProvider,
  brevoDeliveryType,
  brevoEventDetail,
  brevoEventId,
  brevoInboundHint,
  brevoInboundRaw,
  stripBrackets,
  type BrevoEvent,
  type BrevoInboundAttachment,
  type BrevoInboundItem,
} from "@hellobox/providers";
import { and, eq } from "drizzle-orm";
import { cloudflareStatus } from "./cloudflare";
import { brevoProviderFor, loadConnection, markIfRoleRevoked, syncDomains } from "./connections";
import { receivePushedEmail } from "./pushed";
import { recordDeliveryEvent } from "./send";
import { domainLimitFor, importAddedDomain, normalizeDomain, withDns, type DnsHost } from "./ses";

const appUrl = () => getEnv().APP_URL.replace(/\/$/, "");

export const brevoWebhookUrl = (connectionId: string, kind: "inbound" | "events") =>
  `${appUrl()}/api/webhooks/brevo/${connectionId}/${kind}`;

// Connecting

// Checks the key, saves the connection, adds the events webhook and imports the domains.
// Given an existing connection, it reconnects that one; its inbound webhooks keep working,
// since they carry the same token.
export async function connectBrevo(input: { workspaceId: string; apiKey: string; connectionId?: string }) {
  const db = getDb();
  await new BrevoProvider({ workspaceId: input.workspaceId, connectionId: "unsaved", apiKey: input.apiKey, inbound: {} }).account();

  let previous: Awaited<ReturnType<typeof loadConnection>> | undefined;
  if (input.connectionId) {
    previous = await loadConnection(input.connectionId).catch(() => undefined);
    if (!previous || previous.workspaceId !== input.workspaceId || previous.provider !== "brevo") {
      throw new Error("Brevo connection not found");
    }
  }
  const inbound = previous?.config.brevo?.inbound ?? {};
  const token = previous?.webhookSecretEnc ? decrypt(previous.webhookSecretEnc) : randomBytes(32).toString("base64url");
  const values = {
    status: "pending" as const,
    config: { brevo: { inbound, events: false } },
    accessTokenEnc: encrypt(input.apiKey),
    webhookSecretEnc: encrypt(token),
  };
  let connectionId: string;
  if (previous) {
    await db.update(connections).set(values).where(eq(connections.id, previous.id));
    connectionId = previous.id;
  } else {
    const [row] = await db
      .insert(connections)
      .values({ workspaceId: input.workspaceId, provider: "brevo", ...values })
      .returning({ id: connections.id });
    if (!row) throw new Error("Couldn't save the connection");
    connectionId = row.id;
  }

  const provider = brevoProviderFor(await loadConnection(connectionId));
  if (previous?.webhookId) await provider.deleteWebhook(previous.webhookId).catch(() => undefined);
  // Mail still sends and receives without it; it just shows Sent instead of Delivered.
  const eventsId = await provider.createEventsWebhook(brevoWebhookUrl(connectionId, "events"), token).catch((error: unknown) => {
    if (error instanceof BrevoError && error.status === 400) return null;
    throw error;
  });
  await db
    .update(connections)
    .set({ status: "active", config: { brevo: { inbound, events: Boolean(eventsId) } }, webhookId: eventsId })
    .where(eq(connections.id, connectionId));
  await syncDomains(connectionId, input.workspaceId, await domainLimitFor(input.workspaceId));
  return { connectionId, events: Boolean(eventsId) };
}

async function activeBrevo(connectionId: string, workspaceId: string) {
  const connection = await loadConnection(connectionId);
  if (connection.workspaceId !== workspaceId || connection.provider !== "brevo") {
    throw new Error("Brevo connection not found");
  }
  if (connection.status !== "active") throw new Error("This Brevo connection isn't active. Reconnect it first.");
  return { connection, provider: brevoProviderFor(connection) };
}

// Calls Brevo, and marks the connection when the key stopped working.
async function guarded<T>(connectionId: string, work: () => Promise<T>) {
  try {
    return await work();
  } catch (error) {
    await markIfRoleRevoked(connectionId, error);
    throw error;
  }
}

// Domains

export async function addBrevoDomain(connectionId: string, workspaceId: string, name: string) {
  const { connection, provider } = await activeBrevo(connectionId, workspaceId);
  const domain = normalizeDomain(name);
  const records = await guarded(connectionId, () => provider.addDomain(domain));
  const setup = await withDns(connection, null, domain, records);
  await importAddedDomain(connectionId, workspaceId, domain);
  return setup;
}

export async function brevoDomainSetup(connectionId: string, workspaceId: string, domain: string) {
  const { provider } = await activeBrevo(connectionId, workspaceId);
  const [records, cloudflare] = await Promise.all([
    guarded(connectionId, () => provider.domainRecords(domain)),
    cloudflareStatus(workspaceId, domain),
  ]);
  return { records, zoneFound: null, cloudflare };
}

export async function applyBrevoDomainDns(connectionId: string, workspaceId: string, domain: string, host: DnsHost) {
  const { connection, provider } = await activeBrevo(connectionId, workspaceId);
  return withDns(connection, null, domain, await guarded(connectionId, () => provider.domainRecords(domain)), host);
}

// Receiving

// An inbound webhook per receiving domain. Turning a domain off deletes it. Returns the MX
// records' setup for a domain turned on.
export async function setBrevoReceiving(connectionId: string, workspaceId: string, domain: string, on: boolean) {
  const db = getDb();
  const { connection, provider } = await activeBrevo(connectionId, workspaceId);
  const [owned] = await db
    .select({ id: domains.id })
    .from(domains)
    .where(and(eq(domains.connectionId, connectionId), eq(domains.name, domain)));
  if (!owned) throw new Error("That domain isn't part of this connection");
  const brevo = connection.config.brevo!;
  const token = decrypt(connection.webhookSecretEnc!);
  const inbound = { ...brevo.inbound };
  if (on && !inbound[domain]) {
    inbound[domain] = await guarded(connectionId, () => provider.createInboundWebhook(domain, brevoWebhookUrl(connectionId, "inbound"), token));
  }
  if (!on && inbound[domain]) {
    const id = inbound[domain];
    await guarded(connectionId, () => provider.deleteWebhook(id));
    delete inbound[domain];
  }
  provider.target.inbound = inbound;
  await db
    .update(connections)
    .set({ config: { ...connection.config, brevo: { ...brevo, inbound } } })
    .where(eq(connections.id, connectionId));
  await syncDomains(connectionId, workspaceId, await domainLimitFor(workspaceId));
  if (!on) return { mx: null };
  const records = (await provider.domainRecords(domain)).filter((record) => record.type === "MX" && record.name === domain);
  return { mx: await withDns(connection, null, domain, records) };
}

// Webhooks

type WebhookResult = { status: number };

interface WebhookSteps {
  load(connectionId: string): Promise<{ workspaceId: string; token: string } | null>;
  download(connectionId: string, attachment: BrevoInboundAttachment): Promise<Uint8Array>;
  receive: typeof receivePushedEmail;
  recordEvent(connectionId: string, providerEventId: string, type: string, messageId: string, event: BrevoEvent): Promise<void>;
}

const webhookSteps: WebhookSteps = {
  load: async (connectionId) => {
    const connection = await loadConnection(connectionId).catch(() => null);
    if (!connection || connection.provider !== "brevo" || !connection.webhookSecretEnc) return null;
    return { workspaceId: connection.workspaceId, token: decrypt(connection.webhookSecretEnc) };
  },
  download: async (connectionId, attachment) =>
    guarded(connectionId, async () => brevoProviderFor(await loadConnection(connectionId)).downloadAttachment(attachment.DownloadToken)),
  receive: receivePushedEmail,
  recordEvent: async (connectionId, providerEventId, type, messageId, event) => {
    await getDb()
      .insert(webhookEvents)
      .values({ connectionId, providerEventId, type, emailId: messageId, payload: event as Record<string, unknown> })
      .onConflictDoNothing();
    // Safe to repeat: statuses merge per recipient.
    await recordDeliveryEvent(connectionId, type, messageId, brevoEventDetail(event));
  },
};

// The token comes as "Authorization: Bearer …" or in our own header.
export function brevoTokenFrom(headers: { authorization: string | null; token: string | null }) {
  const bearer = headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return bearer || headers.token?.trim() || null;
}

const sameSecret = (given: string | null, expected: string) => {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

async function authorized(
  steps: WebhookSteps,
  connectionId: string,
  token: string | null,
): Promise<{ status: number; connection?: { workspaceId: string; token: string } }> {
  const connection = await steps.load(connectionId);
  if (!connection) return { status: 404 };
  if (!sameSecret(token, connection.token)) return { status: 401 };
  return { status: 200, connection };
}

// Our own id for a received email: the same for Brevo's retries of it.
export const brevoInboundId = (item: BrevoInboundItem) =>
  `bv_${createHash("sha256")
    .update(item.MessageId ? stripBrackets(item.MessageId) : JSON.stringify([item.Uuid, item.From?.Address, item.Subject, item.SentAtDate]))
    .update("\0")
    .update((item.Uuid ?? []).join(","))
    .digest("hex")
    .slice(0, 40)}`;

// New mail, in an `items` list. The post carries the only copy, and the attachments are
// fetched from Brevo with their tokens, so all of it is stored before we answer 200;
// anything that throws becomes a 500 and Brevo sends it again.
export async function handleBrevoInbound(
  connectionId: string,
  input: { token: string | null; payload: { items?: BrevoInboundItem[] } },
  steps: WebhookSteps = webhookSteps,
): Promise<WebhookResult> {
  const check = await authorized(steps, connectionId, input.token);
  if (!check.connection) return { status: check.status };
  const items = Array.isArray(input.payload?.items) ? input.payload.items : null;
  if (!items) return { status: 400 };
  for (const item of items) {
    const files = await Promise.all(
      (item.Attachments ?? []).map(async (attachment) => ({ attachment, content: await steps.download(connectionId, attachment) })),
    );
    const emailId = brevoInboundId(item);
    await steps.receive({
      connectionId,
      workspaceId: check.connection.workspaceId,
      emailId,
      providerEventId: `inbound:${emailId}`,
      raw: await brevoInboundRaw(item, files),
      hint: brevoInboundHint(item),
      payload: { from: item.From?.Address ?? null, subject: item.Subject ?? null },
    });
  }
  return { status: 200 };
}

// Delivery, bounce, block and spam events, one per post (or a list, when batched).
// Anything else with the right token gets a 200 and is ignored.
export async function handleBrevoEvents(
  connectionId: string,
  input: { token: string | null; payload: BrevoEvent | BrevoEvent[] },
  steps: WebhookSteps = webhookSteps,
): Promise<WebhookResult> {
  const check = await authorized(steps, connectionId, input.token);
  if (!check.connection) return { status: check.status };
  const events = Array.isArray(input.payload) ? input.payload : [input.payload];
  for (const event of events) {
    const type = event ? brevoDeliveryType(event) : null;
    const messageId = event?.["message-id"] ? stripBrackets(event["message-id"]) : null;
    if (!type || !messageId) continue;
    await steps.recordEvent(connectionId, brevoEventId(event), type, messageId, event);
  }
  return { status: 200 };
}
