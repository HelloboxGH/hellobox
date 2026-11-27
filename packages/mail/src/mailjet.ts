import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { decrypt, encrypt, getEnv } from "@hellobox/config";
import { connections, domains, getDb, webhookEvents } from "@hellobox/db";
import {
  MailjetProvider,
  mailjetDeliveryType,
  mailjetEventDetail,
  mailjetEventId,
  mailjetEventMessageId,
  mailjetInboundHint,
  mailjetInboundRaw,
  type MailjetEvent,
  type MailjetInbound,
} from "@hellobox/providers";
import { and, eq } from "drizzle-orm";
import { cloudflareStatus } from "./cloudflare";
import { loadConnection, mailjetProviderFor, markIfRoleRevoked, syncDomains } from "./connections";
import { receivePushedEmail } from "./pushed";
import { recordDeliveryEvent } from "./send";
import { domainLimitFor, importAddedDomain, normalizeDomain, withDns, type DnsHost } from "./ses";

type Connection = Awaited<ReturnType<typeof loadConnection>>;

const appUrl = () => getEnv().APP_URL.replace(/\/$/, "");

// Mailjet signs neither its parse posts nor its events, so both addresses carry the
// connection's secret.
export const mailjetWebhookUrl = (connectionId: string, kind: "inbound" | "events", token: string) =>
  `${appUrl()}/api/webhooks/mailjet/${connectionId}/${kind}?key=${encodeURIComponent(token)}`;

// Connecting

// Checks the keys, saves the connection, adds the event callbacks and imports the
// domains. Given an existing connection, it reconnects that one; its parse routes keep
// working, since their address stays the same.
export async function connectMailjet(input: { workspaceId: string; apiKey: string; secretKey: string; connectionId?: string }) {
  const db = getDb();
  await new MailjetProvider({ workspaceId: input.workspaceId, connectionId: "unsaved", apiKey: input.apiKey, secretKey: input.secretKey, inbound: {} }).allDns();

  let previous: Connection | undefined;
  if (input.connectionId) {
    previous = await loadConnection(input.connectionId).catch(() => undefined);
    if (!previous || previous.workspaceId !== input.workspaceId || previous.provider !== "mailjet") {
      throw new Error("Mailjet connection not found");
    }
  }
  const inbound = previous?.config.mailjet?.inbound ?? {};
  const token = previous?.webhookSecretEnc ? decrypt(previous.webhookSecretEnc) : randomBytes(32).toString("base64url");
  const values = {
    status: "pending" as const,
    config: { mailjet: { inbound, callbacks: [], events: false } },
    accessTokenEnc: encrypt(input.secretKey),
    secondaryTokenEnc: encrypt(input.apiKey),
    webhookSecretEnc: encrypt(token),
  };
  let connectionId: string;
  if (previous) {
    await db.update(connections).set(values).where(eq(connections.id, previous.id));
    connectionId = previous.id;
  } else {
    const [row] = await db
      .insert(connections)
      .values({ workspaceId: input.workspaceId, provider: "mailjet", ...values })
      .returning({ id: connections.id });
    if (!row) throw new Error("Couldn't save the connection");
    connectionId = row.id;
  }

  const provider = mailjetProviderFor(await loadConnection(connectionId));
  for (const id of previous?.config.mailjet?.callbacks ?? []) await provider.deleteEventCallback(id).catch(() => undefined);
  // Mail still sends and receives without them; it just shows Sent instead of Delivered.
  const callbacks = await provider.createEventCallbacks(mailjetWebhookUrl(connectionId, "events", token));
  await db
    .update(connections)
    .set({ status: "active", config: { mailjet: { inbound, callbacks: callbacks.ids, events: callbacks.complete } } })
    .where(eq(connections.id, connectionId));
  await syncDomains(connectionId, input.workspaceId, await domainLimitFor(input.workspaceId));
  return { connectionId, events: callbacks.complete };
}

async function activeMailjet(connectionId: string, workspaceId: string) {
  const connection = await loadConnection(connectionId);
  if (connection.workspaceId !== workspaceId || connection.provider !== "mailjet") {
    throw new Error("Mailjet connection not found");
  }
  if (connection.status !== "active") throw new Error("This Mailjet connection isn't active. Reconnect it first.");
  return { connection, provider: mailjetProviderFor(connection) };
}

// Calls Mailjet, and marks the connection when the keys stopped working.
async function guarded<T>(connectionId: string, work: () => Promise<T>) {
  try {
    return await work();
  } catch (error) {
    await markIfRoleRevoked(connectionId, error);
    throw error;
  }
}

// Domains

export async function addMailjetDomain(connectionId: string, workspaceId: string, name: string) {
  const { connection, provider } = await activeMailjet(connectionId, workspaceId);
  const domain = normalizeDomain(name);
  const records = await guarded(connectionId, () => provider.addDomain(domain));
  const setup = await withDns(connection, null, domain, records);
  await importAddedDomain(connectionId, workspaceId, domain);
  return setup;
}

export async function mailjetDomainSetup(connectionId: string, workspaceId: string, domain: string) {
  const { provider } = await activeMailjet(connectionId, workspaceId);
  const [records, cloudflare] = await Promise.all([
    guarded(connectionId, () => provider.domainRecords(domain)),
    cloudflareStatus(workspaceId, domain),
  ]);
  return { records, zoneFound: null, cloudflare };
}

export async function applyMailjetDomainDns(connectionId: string, workspaceId: string, domain: string, host: DnsHost) {
  const { connection, provider } = await activeMailjet(connectionId, workspaceId);
  return withDns(connection, null, domain, await guarded(connectionId, () => provider.domainRecords(domain)), host);
}

// Receiving

// A parse route per receiving domain. Turning a domain off deletes it. Returns the MX
// record's setup for a domain turned on. Mailjet only parses on paid plans, and says so.
export async function setMailjetReceiving(connectionId: string, workspaceId: string, domain: string, on: boolean) {
  const db = getDb();
  const { connection, provider } = await activeMailjet(connectionId, workspaceId);
  const [owned] = await db
    .select({ id: domains.id })
    .from(domains)
    .where(and(eq(domains.connectionId, connectionId), eq(domains.name, domain)));
  if (!owned) throw new Error("That domain isn't part of this connection");
  const mailjet = connection.config.mailjet!;
  const token = decrypt(connection.webhookSecretEnc!);
  const inbound = { ...mailjet.inbound };
  if (on && !inbound[domain]) {
    inbound[domain] = await guarded(connectionId, () => provider.createRoute(domain, mailjetWebhookUrl(connectionId, "inbound", token)));
  }
  if (!on && inbound[domain]) {
    const id = inbound[domain];
    await guarded(connectionId, () => provider.deleteRoute(id));
    delete inbound[domain];
  }
  provider.target.inbound = inbound;
  await db
    .update(connections)
    .set({ config: { ...connection.config, mailjet: { ...mailjet, inbound } } })
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
  receive: typeof receivePushedEmail;
  recordEvent(connectionId: string, providerEventId: string, type: string, messageId: string, event: MailjetEvent): Promise<void>;
}

const webhookSteps: WebhookSteps = {
  load: async (connectionId) => {
    const connection = await loadConnection(connectionId).catch(() => null);
    if (!connection || connection.provider !== "mailjet" || !connection.webhookSecretEnc) return null;
    return { workspaceId: connection.workspaceId, token: decrypt(connection.webhookSecretEnc) };
  },
  receive: receivePushedEmail,
  recordEvent: async (connectionId, providerEventId, type, messageId, event) => {
    await getDb()
      .insert(webhookEvents)
      .values({ connectionId, providerEventId, type, emailId: messageId, payload: event as Record<string, unknown> })
      .onConflictDoNothing();
    // Safe to repeat: statuses merge per recipient.
    await recordDeliveryEvent(connectionId, type, messageId, mailjetEventDetail(event));
  },
};

const sameSecret = (given: string | null, expected: string) => {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

async function authorized(steps: WebhookSteps, connectionId: string, key: string | null) {
  const connection = await steps.load(connectionId);
  if (!connection) return { status: 404 };
  if (!sameSecret(key, connection.token)) return { status: 401 };
  return { status: 200, connection };
}

const headerValue = (payload: MailjetInbound, name: string) => {
  const value = Object.entries(payload.Headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
  return Array.isArray(value) ? value[0] : value;
};

// Our own id for a received email: the same for Mailjet's retries of it, and different
// for each recipient it was delivered to.
export const mailjetInboundId = (payload: MailjetInbound) =>
  `mj_${createHash("sha256")
    .update(headerValue(payload, "message-id") ?? JSON.stringify([payload.Sender, payload.Subject, headerValue(payload, "date")]))
    .update("\0")
    .update(payload.Recipient?.toLowerCase() ?? "")
    .digest("hex")
    .slice(0, 40)}`;

// New mail. The post carries the only copy, so it's stored before we answer 200;
// anything that throws becomes a 500 and Mailjet sends it again.
export async function handleMailjetInbound(
  connectionId: string,
  input: { key: string | null; payload: MailjetInbound },
  steps: WebhookSteps = webhookSteps,
): Promise<WebhookResult> {
  const check = await authorized(steps, connectionId, input.key);
  if (!check.connection) return { status: check.status };
  if (!input.payload || typeof input.payload !== "object" || !input.payload.Headers) return { status: 400 };
  const emailId = mailjetInboundId(input.payload);
  await steps.receive({
    connectionId,
    workspaceId: check.connection.workspaceId,
    emailId,
    providerEventId: `inbound:${emailId}`,
    raw: await mailjetInboundRaw(input.payload),
    hint: mailjetInboundHint(input.payload),
    payload: { from: input.payload.Sender ?? null, subject: input.payload.Subject ?? null },
  });
  return { status: 200 };
}

// Delivery, bounce, block and spam events: a list when grouped, one event otherwise.
export async function handleMailjetEvents(
  connectionId: string,
  input: { key: string | null; payload: MailjetEvent | MailjetEvent[] },
  steps: WebhookSteps = webhookSteps,
): Promise<WebhookResult> {
  const check = await authorized(steps, connectionId, input.key);
  if (!check.connection) return { status: check.status };
  const events = Array.isArray(input.payload) ? input.payload : [input.payload];
  for (const event of events) {
    const type = event ? mailjetDeliveryType(event) : null;
    const messageId = event ? mailjetEventMessageId(event) : null;
    if (!type || !messageId) continue;
    await steps.recordEvent(connectionId, mailjetEventId(event), type, messageId, event);
  }
  return { status: 200 };
}
