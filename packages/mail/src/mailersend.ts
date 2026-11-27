import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { decrypt, encrypt, getEnv } from "@hellobox/config";
import { connections, domains, getDb, webhookEvents } from "@hellobox/db";
import {
  MailersendError,
  MailersendProvider,
  mailersendDeliveryType,
  mailersendEventDetail,
  mailersendInboundHint,
  mailersendInboundRaw,
  verifyMailersendSignature,
  type MailersendEvent,
  type MailersendInboundData,
} from "@hellobox/providers";
import { and, eq } from "drizzle-orm";
import { cloudflareStatus } from "./cloudflare";
import { loadConnection, mailersendProviderFor, markIfRoleRevoked, syncDomains } from "./connections";
import { receivePushedEmail } from "./pushed";
import { recordDeliveryEvent } from "./send";
import { domainLimitFor, importAddedDomain, normalizeDomain, withDns, type DnsHost } from "./ses";

type Connection = Awaited<ReturnType<typeof loadConnection>>;

const appUrl = () => getEnv().APP_URL.replace(/\/$/, "");

export const mailersendEventsUrl = (connectionId: string) => `${appUrl()}/api/webhooks/mailersend/${connectionId}/events`;

// Which inbound posts are signed, and how, isn't documented, so the address carries a
// secret of its own.
export const mailersendInboundUrl = (connectionId: string, token: string) =>
  `${appUrl()}/api/webhooks/mailersend/${connectionId}/inbound?key=${encodeURIComponent(token)}`;

// Connecting

// Checks the token, saves the connection, imports the domains and adds an events webhook
// to each. Given an existing connection, it reconnects that one; its inbound routes keep
// working, since their address stays the same.
export async function connectMailersend(input: { workspaceId: string; apiKey: string; connectionId?: string }) {
  const db = getDb();
  await new MailersendProvider({ workspaceId: input.workspaceId, connectionId: "unsaved", apiKey: input.apiKey, inbound: {} }).allDomains();

  let previous: Connection | undefined;
  if (input.connectionId) {
    previous = await loadConnection(input.connectionId).catch(() => undefined);
    if (!previous || previous.workspaceId !== input.workspaceId || previous.provider !== "mailersend") {
      throw new Error("MailerSend connection not found");
    }
  }
  const inbound = previous?.config.mailersend?.inbound ?? {};
  const values = {
    status: "pending" as const,
    // Webhooks are made again with the new token, below.
    config: { mailersend: { inbound, webhooks: {}, events: true } },
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
      .values({ workspaceId: input.workspaceId, provider: "mailersend", ...values })
      .returning({ id: connections.id });
    if (!row) throw new Error("Couldn't save the connection");
    connectionId = row.id;
  }

  const provider = mailersendProviderFor(await loadConnection(connectionId));
  for (const webhook of Object.values(previous?.config.mailersend?.webhooks ?? {})) {
    await provider.deleteWebhook(webhook.id).catch(() => undefined);
  }
  await db.update(connections).set({ status: "active" }).where(eq(connections.id, connectionId));
  const events = await ensureMailersendWebhooks(connectionId);
  await syncDomains(connectionId, input.workspaceId, await domainLimitFor(input.workspaceId));
  return { connectionId, events };
}

// An events webhook on every domain that has none: MailerSend's webhooks belong to one
// domain each. A plan out of webhooks leaves the rest without, and says so. Returns
// whether every domain has one.
export async function ensureMailersendWebhooks(connectionId: string) {
  const db = getDb();
  const connection = await loadConnection(connectionId);
  const mailersend = connection.config.mailersend!;
  const provider = mailersendProviderFor(connection);
  const webhooks = { ...mailersend.webhooks };
  let events = true;
  for (const domain of await provider.allDomains()) {
    if (webhooks[domain.id]) continue;
    try {
      const created = await provider.createEventsWebhook(domain.id, mailersendEventsUrl(connectionId));
      webhooks[domain.id] = { id: created.id, secretEnc: encrypt(created.secret) };
    } catch (error) {
      if (!(error instanceof MailersendError && (error.status === 403 || error.status === 422))) throw error;
      events = false;
    }
  }
  await db
    .update(connections)
    .set({ config: { ...connection.config, mailersend: { ...mailersend, webhooks, events } } })
    .where(eq(connections.id, connectionId));
  return events;
}

async function activeMailersend(connectionId: string, workspaceId: string) {
  const connection = await loadConnection(connectionId);
  if (connection.workspaceId !== workspaceId || connection.provider !== "mailersend") {
    throw new Error("MailerSend connection not found");
  }
  if (connection.status !== "active") throw new Error("This MailerSend connection isn't active. Reconnect it first.");
  return { connection, provider: mailersendProviderFor(connection) };
}

// Calls MailerSend, and marks the connection when the token stopped working.
async function guarded<T>(connectionId: string, work: () => Promise<T>) {
  try {
    return await work();
  } catch (error) {
    await markIfRoleRevoked(connectionId, error);
    throw error;
  }
}

// Domains

export async function addMailersendDomain(connectionId: string, workspaceId: string, name: string) {
  const { connection, provider } = await activeMailersend(connectionId, workspaceId);
  const domain = normalizeDomain(name);
  const records = await guarded(connectionId, () => provider.addDomain(domain));
  await ensureMailersendWebhooks(connectionId);
  const setup = await withDns(connection, null, domain, records);
  await importAddedDomain(connectionId, workspaceId, domain);
  return setup;
}

export async function mailersendDomainSetup(connectionId: string, workspaceId: string, domain: string) {
  const { provider } = await activeMailersend(connectionId, workspaceId);
  const [records, cloudflare] = await Promise.all([
    guarded(connectionId, () => provider.domainRecords(domain)),
    cloudflareStatus(workspaceId, domain),
  ]);
  return { records, zoneFound: null, cloudflare };
}

export async function applyMailersendDomainDns(connectionId: string, workspaceId: string, domain: string, host: DnsHost) {
  const { connection, provider } = await activeMailersend(connectionId, workspaceId);
  return withDns(connection, null, domain, await guarded(connectionId, () => provider.domainRecords(domain)), host);
}

// Receiving

// A catch-all inbound route per receiving domain. Turning a domain off deletes it.
// Returns the MX record's setup for a domain turned on.
export async function setMailersendReceiving(connectionId: string, workspaceId: string, domain: string, on: boolean) {
  const db = getDb();
  const { connection, provider } = await activeMailersend(connectionId, workspaceId);
  const [owned] = await db
    .select({ id: domains.id })
    .from(domains)
    .where(and(eq(domains.connectionId, connectionId), eq(domains.name, domain)));
  if (!owned) throw new Error("That domain isn't part of this connection");
  const mailersend = connection.config.mailersend!;
  const token = decrypt(connection.secondaryTokenEnc!);
  const inbound = { ...mailersend.inbound };
  if (on && !inbound[domain]) {
    inbound[domain] = await guarded(connectionId, () => provider.createRoute(domain, mailersendInboundUrl(connectionId, token)));
  }
  if (!on && inbound[domain]) {
    const { routeId } = inbound[domain];
    await guarded(connectionId, () => provider.deleteRoute(routeId));
    delete inbound[domain];
  }
  provider.target.inbound = inbound;
  await db
    .update(connections)
    .set({ config: { ...connection.config, mailersend: { ...mailersend, inbound } } })
    .where(eq(connections.id, connectionId));
  await syncDomains(connectionId, workspaceId, await domainLimitFor(workspaceId));
  if (!on) return { mx: null };
  const records = (await provider.domainRecords(domain)).filter((record) => record.type === "MX" && record.name === domain);
  return { mx: await withDns(connection, null, domain, records) };
}

// Webhooks

type WebhookResult = { status: number };

interface WebhookSteps {
  load(connectionId: string): Promise<{ workspaceId: string; inboundToken: string | null; secrets: Record<string, string> } | null>;
  receive: typeof receivePushedEmail;
  recordEvent(connectionId: string, providerEventId: string, type: string, messageId: string, event: MailersendEvent): Promise<void>;
}

const webhookSteps: WebhookSteps = {
  load: async (connectionId) => {
    const connection = await loadConnection(connectionId).catch(() => null);
    if (!connection || connection.provider !== "mailersend") return null;
    const webhooks = connection.config.mailersend?.webhooks ?? {};
    return {
      workspaceId: connection.workspaceId,
      inboundToken: connection.secondaryTokenEnc ? decrypt(connection.secondaryTokenEnc) : null,
      secrets: Object.fromEntries(Object.entries(webhooks).map(([domainId, webhook]) => [domainId, decrypt(webhook.secretEnc)])),
    };
  },
  receive: receivePushedEmail,
  recordEvent: async (connectionId, providerEventId, type, messageId, event) => {
    await getDb()
      .insert(webhookEvents)
      .values({ connectionId, providerEventId, type, emailId: messageId, payload: event as Record<string, unknown> })
      .onConflictDoNothing();
    // Safe to repeat: statuses merge per recipient.
    await recordDeliveryEvent(connectionId, type, messageId, mailersendEventDetail(event));
  },
};

const sameSecret = (given: string | null, expected: string) => {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

// Our own id for a received email: the same for MailerSend's retries of it.
export const mailersendInboundId = (data: MailersendInboundData) =>
  `ms_${createHash("sha256")
    .update(data.id ?? JSON.stringify([data.from?.email, data.subject, data.date, data.headers?.["Message-ID"]]))
    .digest("hex")
    .slice(0, 40)}`;

// New mail. The post carries the only copy, so it's stored before we answer 200;
// anything that throws becomes a 500 and MailerSend sends it again. Its test post when a
// route is saved gets a 200 too.
export async function handleMailersendInbound(
  connectionId: string,
  input: { key: string | null; payload: { type?: string; data?: MailersendInboundData } },
  steps: WebhookSteps = webhookSteps,
): Promise<WebhookResult> {
  const connection = await steps.load(connectionId);
  if (!connection?.inboundToken) return { status: 404 };
  if (!sameSecret(input.key, connection.inboundToken)) return { status: 401 };
  if (input.payload?.type === "webhook.test") return { status: 200 };
  const data = input.payload?.data;
  if (input.payload?.type !== "inbound.message" || !data) return { status: 400 };
  const emailId = mailersendInboundId(data);
  await steps.receive({
    connectionId,
    workspaceId: connection.workspaceId,
    emailId,
    providerEventId: `inbound:${emailId}`,
    raw: await mailersendInboundRaw(data),
    hint: mailersendInboundHint(data),
    payload: { from: data.from?.email ?? null, subject: data.subject ?? null },
  });
  return { status: 200 };
}

// Delivery, bounce and spam events, signed with the secret of the domain's webhook.
export async function handleMailersendEvents(
  connectionId: string,
  input: { signature: string | null; body: Uint8Array },
  steps: WebhookSteps = webhookSteps,
): Promise<WebhookResult> {
  const connection = await steps.load(connectionId);
  if (!connection) return { status: 404 };
  let event: MailersendEvent;
  try {
    event = JSON.parse(new TextDecoder().decode(input.body)) as MailersendEvent;
  } catch {
    return { status: 400 };
  }
  // The body names the domain, which names the secret; nothing in it is used before the
  // signature checks out.
  const secret = event?.data?.domain_id ? connection.secrets[event.data.domain_id] : undefined;
  if (!secret || !verifyMailersendSignature(secret, input.signature, input.body)) return { status: 401 };
  const type = mailersendDeliveryType(event);
  const messageId = event.data?.message_id;
  if (!type || !messageId) return { status: 200 };
  await steps.recordEvent(connectionId, event.data?.id ?? `${type}:${messageId}:${event.data?.recipient ?? ""}`, type, messageId, event);
  return { status: 200 };
}
