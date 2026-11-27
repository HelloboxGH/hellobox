import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { decrypt, encrypt, getEnv } from "@hellobox/config";
import { connections, domains, getDb, webhookEvents } from "@hellobox/db";
import {
  detectSendgridRegion,
  SendgridError,
  sendgridDeliveryType,
  sendgridEventDetail,
  sendgridMessageId,
  verifySendgridSignature,
  type SendgridEvent,
} from "@hellobox/providers";
import { and, eq } from "drizzle-orm";
import { cloudflareStatus } from "./cloudflare";
import { loadConnection, markIfRoleRevoked, sendgridProviderFor, syncDomains } from "./connections";
import { receivePushedEmail } from "./pushed";
import { recordDeliveryEvent } from "./send";
import { domainLimitFor, importAddedDomain, normalizeDomain, withDns, type DnsHost } from "./ses";

const appUrl = () => getEnv().APP_URL.replace(/\/$/, "");

export const sendgridEventsUrl = (connectionId: string) => `${appUrl()}/api/webhooks/sendgrid/${connectionId}/events`;

// Inbound Parse posts aren't signed, so the address carries a secret of its own.
export const sendgridInboundUrl = (connectionId: string, token: string) =>
  `${appUrl()}/api/webhooks/sendgrid/${connectionId}/inbound?key=${encodeURIComponent(token)}`;

// Connecting

// Checks the key and finds its region, saves the connection, adds the signed events
// webhook and imports the domains. Given an existing connection, it reconnects that one.
export async function connectSendgrid(input: { workspaceId: string; apiKey: string; connectionId?: string }) {
  const db = getDb();
  const region = await detectSendgridRegion(input.apiKey);
  if (!region) throw new SendgridError("SendGrid didn't accept the API key", 401);

  let previous: Awaited<ReturnType<typeof loadConnection>> | undefined;
  if (input.connectionId) {
    previous = await loadConnection(input.connectionId).catch(() => undefined);
    if (!previous || previous.workspaceId !== input.workspaceId || previous.provider !== "sendgrid") {
      throw new Error("SendGrid connection not found");
    }
  }
  // Receiving stays with the connection when it's the same region; a new region starts over.
  const receiving = previous?.config.sendgrid?.region === region ? previous.config.sendgrid.receiving : [];
  const values = {
    status: "pending" as const,
    config: { sendgrid: { region, receiving, events: false } },
    accessTokenEnc: encrypt(input.apiKey),
    secondaryTokenEnc: previous?.secondaryTokenEnc ?? encrypt(randomBytes(24).toString("base64url")),
  };
  let connectionId: string;
  if (previous) {
    await db.update(connections).set(values).where(eq(connections.id, previous.id));
    connectionId = previous.id;
  } else {
    const [row] = await db
      .insert(connections)
      .values({ workspaceId: input.workspaceId, provider: "sendgrid", ...values })
      .returning({ id: connections.id });
    if (!row) throw new Error("Couldn't save the connection");
    connectionId = row.id;
  }

  const provider = sendgridProviderFor(await loadConnection(connectionId));
  if (previous?.webhookId) await provider.deleteEventsWebhook(previous.webhookId).catch(() => undefined);
  // SendGrid caps events webhooks by plan, and the customer may already use theirs. Mail
  // still sends and receives without one; it just shows Sent instead of Delivered.
  const events = await provider.createEventsWebhook(sendgridEventsUrl(connectionId)).catch((error: unknown) => {
    if (error instanceof SendgridError && error.status === 400) return null;
    throw error;
  });
  await db
    .update(connections)
    .set({
      status: "active",
      config: { sendgrid: { region, receiving, events: Boolean(events) } },
      webhookId: events?.id ?? null,
      webhookSecretEnc: events ? encrypt(events.publicKey) : null,
    })
    .where(eq(connections.id, connectionId));
  // Parse settings made by the previous key point at the same address, so they keep working.
  await syncDomains(connectionId, input.workspaceId, await domainLimitFor(input.workspaceId));
  return { connectionId, region, events: Boolean(events) };
}

async function activeSendgrid(connectionId: string, workspaceId: string) {
  const connection = await loadConnection(connectionId);
  if (connection.workspaceId !== workspaceId || connection.provider !== "sendgrid") {
    throw new Error("SendGrid connection not found");
  }
  if (connection.status !== "active") throw new Error("This SendGrid connection isn't active. Reconnect it first.");
  return { connection, provider: sendgridProviderFor(connection) };
}

// Calls SendGrid, and marks the connection when the key stopped working.
async function guarded<T>(connectionId: string, work: () => Promise<T>) {
  try {
    return await work();
  } catch (error) {
    await markIfRoleRevoked(connectionId, error);
    throw error;
  }
}

// Domains

export async function addSendgridDomain(connectionId: string, workspaceId: string, name: string) {
  const { connection, provider } = await activeSendgrid(connectionId, workspaceId);
  const domain = normalizeDomain(name);
  const records = await guarded(connectionId, () => provider.addDomain(domain));
  const setup = await withDns(connection, null, domain, records);
  await importAddedDomain(connectionId, workspaceId, domain);
  return setup;
}

export async function sendgridDomainSetup(connectionId: string, workspaceId: string, domain: string) {
  const { provider } = await activeSendgrid(connectionId, workspaceId);
  const [records, cloudflare] = await Promise.all([
    guarded(connectionId, () => provider.domainRecords(domain)),
    cloudflareStatus(workspaceId, domain),
  ]);
  return { records, zoneFound: null, cloudflare };
}

export async function applySendgridDomainDns(connectionId: string, workspaceId: string, domain: string, host: DnsHost) {
  const { connection, provider } = await activeSendgrid(connectionId, workspaceId);
  return withDns(connection, null, domain, await guarded(connectionId, () => provider.domainRecords(domain)), host);
}

// Receiving

// An Inbound Parse setting per receiving domain, posting the raw message to us. Turning a
// domain off deletes it. Returns the MX record's setup for a domain turned on.
export async function setSendgridReceiving(connectionId: string, workspaceId: string, domain: string, on: boolean) {
  const db = getDb();
  const { connection, provider } = await activeSendgrid(connectionId, workspaceId);
  const [owned] = await db
    .select({ id: domains.id })
    .from(domains)
    .where(and(eq(domains.connectionId, connectionId), eq(domains.name, domain)));
  if (!owned) throw new Error("That domain isn't part of this connection");
  const sendgrid = connection.config.sendgrid!;
  const token = decrypt(connection.secondaryTokenEnc!);
  const receiving = new Set(sendgrid.receiving);
  if (on && !receiving.has(domain)) {
    await guarded(connectionId, () => provider.createParse(domain, sendgridInboundUrl(connectionId, token)));
    receiving.add(domain);
  }
  if (!on && receiving.has(domain)) {
    await guarded(connectionId, () => provider.deleteParse(domain));
    receiving.delete(domain);
  }
  provider.target.receiving = [...receiving];
  await db
    .update(connections)
    .set({ config: { ...connection.config, sendgrid: { ...sendgrid, receiving: [...receiving] } } })
    .where(eq(connections.id, connectionId));
  await syncDomains(connectionId, workspaceId, await domainLimitFor(workspaceId));
  if (!on) return { mx: null };
  const records = (await provider.domainRecords(domain)).filter((record) => record.type === "MX" && record.name === domain);
  return { mx: await withDns(connection, null, domain, records) };
}

// Webhooks

type WebhookResult = { status: number };

interface WebhookSteps {
  load(connectionId: string): Promise<{ workspaceId: string; inboundToken: string | null; publicKey: string | null } | null>;
  receive: typeof receivePushedEmail;
  recordEvent(connectionId: string, providerEventId: string, type: string, messageId: string, event: SendgridEvent): Promise<void>;
}

const webhookSteps: WebhookSteps = {
  load: async (connectionId) => {
    const connection = await loadConnection(connectionId).catch(() => null);
    if (!connection || connection.provider !== "sendgrid") return null;
    return {
      workspaceId: connection.workspaceId,
      inboundToken: connection.secondaryTokenEnc ? decrypt(connection.secondaryTokenEnc) : null,
      publicKey: connection.webhookSecretEnc ? decrypt(connection.webhookSecretEnc) : null,
    };
  },
  receive: receivePushedEmail,
  recordEvent: async (connectionId, providerEventId, type, messageId, event) => {
    await getDb()
      .insert(webhookEvents)
      .values({ connectionId, providerEventId, type, emailId: messageId, payload: event as Record<string, unknown> })
      .onConflictDoNothing();
    // Safe to repeat when SendGrid sends the batch again: statuses merge per recipient.
    await recordDeliveryEvent(connectionId, type, messageId, sendgridEventDetail(event));
  },
};

const sameSecret = (given: string | null, expected: string) => {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

// Our own id for a received email: the same for SendGrid's retries of it.
export const sendgridInboundId = (raw: Uint8Array) => `sg_${createHash("sha256").update(raw).digest("hex").slice(0, 40)}`;

// A mail for a receiving domain. The post carries the only copy, so it's stored before we
// answer 200; anything that throws becomes a 500 and SendGrid sends it again.
export async function handleSendgridInbound(
  connectionId: string,
  input: { key: string | null; fields: Record<string, string> },
  steps: WebhookSteps = webhookSteps,
): Promise<WebhookResult> {
  const connection = await steps.load(connectionId);
  if (!connection?.inboundToken) return { status: 404 };
  if (!sameSecret(input.key, connection.inboundToken)) return { status: 401 };
  const email = input.fields.email;
  if (!email) return { status: 400 };
  const raw = new TextEncoder().encode(email);
  let recipients: string[] = [];
  try {
    const envelope = JSON.parse(input.fields.envelope ?? "{}") as { to?: unknown };
    if (Array.isArray(envelope.to)) recipients = envelope.to.filter((value): value is string => typeof value === "string").map((value) => value.toLowerCase());
  } catch {
    // The recipients are read from the message itself too.
  }
  const spf = input.fields.SPF?.trim().toLowerCase();
  const emailId = sendgridInboundId(raw);
  await steps.receive({
    connectionId,
    workspaceId: connection.workspaceId,
    emailId,
    providerEventId: `inbound:${emailId}`,
    raw,
    hint: { recipients, ...(spf && /^[a-z]+$/.test(spf) ? { authentication: { spf } } : {}) },
    payload: { from: input.fields.from ?? null, subject: input.fields.subject ?? null },
  });
  return { status: 200 };
}

// Delivery, bounce, drop, delay and spam-report events, in batches. Anything else signed
// gets a 200 and is ignored.
export async function handleSendgridEvents(
  connectionId: string,
  input: { signature: string | null; timestamp: string | null; body: Uint8Array },
  steps: WebhookSteps = webhookSteps,
  now = Date.now(),
): Promise<WebhookResult> {
  const connection = await steps.load(connectionId);
  if (!connection?.publicKey) return { status: 404 };
  if (!verifySendgridSignature(connection.publicKey, input, now)) return { status: 401 };
  let events: SendgridEvent[];
  try {
    const parsed = JSON.parse(new TextDecoder().decode(input.body)) as unknown;
    events = Array.isArray(parsed) ? (parsed as SendgridEvent[]) : [];
  } catch {
    return { status: 400 };
  }
  for (const event of events) {
    const type = sendgridDeliveryType(event);
    const messageId = sendgridMessageId(event);
    if (!type || !messageId) continue;
    await steps.recordEvent(connectionId, event.sg_event_id ?? `${type}:${messageId}:${event.email ?? ""}`, type, messageId, event);
  }
  return { status: 200 };
}
