import { decrypt, encrypt, getEnv } from "@hellobox/config";
import { connections, domains, getDb, webhookEvents } from "@hellobox/db";
import {
  BirdError,
  birdDeliveryType,
  birdEventDetail,
  birdInboundHint,
  detectBirdRegion,
  verifyBirdSignature,
  type BirdEvent,
} from "@hellobox/providers";
import { enqueueIngest } from "@hellobox/queue";
import { and, eq } from "drizzle-orm";
import { cloudflareStatus } from "./cloudflare";
import { birdProviderFor, loadConnection, markIfRoleRevoked, syncDomains } from "./connections";
import { recordDeliveryEvent } from "./send";
import { domainLimitFor, importAddedDomain, normalizeDomain, withDns, type DnsHost } from "./ses";

type Connection = Awaited<ReturnType<typeof loadConnection>>;

const appUrl = () => getEnv().APP_URL.replace(/\/$/, "");

export const birdWebhookUrl = (connectionId: string) => `${appUrl()}/api/webhooks/bird/${connectionId}`;

// Connecting

// Checks the key and finds its region, saves the connection, adds the signed webhook
// (delivery events and received mail) and imports the domains. Given an existing
// connection, it reconnects that one.
export async function connectBird(input: { workspaceId: string; apiKey: string; connectionId?: string }) {
  const db = getDb();
  const region = await detectBirdRegion(input.apiKey);
  if (!region) throw new BirdError("Bird didn't accept the access key", 401);

  let previous: Connection | undefined;
  if (input.connectionId) {
    previous = await loadConnection(input.connectionId).catch(() => undefined);
    if (!previous || previous.workspaceId !== input.workspaceId || previous.provider !== "bird") {
      throw new Error("Bird connection not found");
    }
  }
  // Receiving is a setting of the domains, so it carries over within the same region.
  const receiving = previous?.config.bird?.region === region ? previous.config.bird.receiving : [];
  const values = { status: "pending" as const, config: { bird: { region, receiving } }, accessTokenEnc: encrypt(input.apiKey) };
  let connectionId: string;
  if (previous) {
    await db.update(connections).set(values).where(eq(connections.id, previous.id));
    connectionId = previous.id;
  } else {
    const [row] = await db
      .insert(connections)
      .values({ workspaceId: input.workspaceId, provider: "bird", ...values })
      .returning({ id: connections.id });
    if (!row) throw new Error("Couldn't save the connection");
    connectionId = row.id;
  }

  const provider = birdProviderFor(await loadConnection(connectionId));
  if (previous?.webhookId) await provider.deleteWebhook(previous.webhookId).catch(() => undefined);
  const webhook = await provider.createWebhook(birdWebhookUrl(connectionId));
  await db
    .update(connections)
    .set({ status: "active", webhookId: webhook.id, webhookSecretEnc: encrypt(webhook.secret) })
    .where(eq(connections.id, connectionId));
  await syncDomains(connectionId, input.workspaceId, await domainLimitFor(input.workspaceId));
  return { connectionId, region };
}

async function activeBird(connectionId: string, workspaceId: string) {
  const connection = await loadConnection(connectionId);
  if (connection.workspaceId !== workspaceId || connection.provider !== "bird") {
    throw new Error("Bird connection not found");
  }
  if (connection.status !== "active") throw new Error("This Bird connection isn't active. Reconnect it first.");
  return { connection, provider: birdProviderFor(connection) };
}

// Calls Bird, and marks the connection when the key stopped working.
async function guarded<T>(connectionId: string, work: () => Promise<T>) {
  try {
    return await work();
  } catch (error) {
    await markIfRoleRevoked(connectionId, error);
    throw error;
  }
}

// Domains

export async function addBirdDomain(connectionId: string, workspaceId: string, name: string) {
  const { connection, provider } = await activeBird(connectionId, workspaceId);
  const domain = normalizeDomain(name);
  const records = await guarded(connectionId, () => provider.addDomain(domain));
  const setup = await withDns(connection, null, domain, records);
  await importAddedDomain(connectionId, workspaceId, domain);
  return setup;
}

export async function birdDomainSetup(connectionId: string, workspaceId: string, domain: string) {
  const { provider } = await activeBird(connectionId, workspaceId);
  const [records, cloudflare] = await Promise.all([
    guarded(connectionId, () => provider.domainRecords(domain)),
    cloudflareStatus(workspaceId, domain),
  ]);
  return { records, zoneFound: null, cloudflare };
}

export async function applyBirdDomainDns(connectionId: string, workspaceId: string, domain: string, host: DnsHost) {
  const { connection, provider } = await activeBird(connectionId, workspaceId);
  return withDns(connection, null, domain, await guarded(connectionId, () => provider.domainRecords(domain)), host);
}

// Receiving

// Bird's receiving switch on the domain. Bird turns it on only once the domain's DKIM
// checks out; until then the domain waits, and its MX records are shown already. Returns
// the MX records' setup for a domain turned on.
export async function setBirdReceiving(connectionId: string, workspaceId: string, domain: string, on: boolean) {
  const db = getDb();
  const { connection, provider } = await activeBird(connectionId, workspaceId);
  const [owned] = await db
    .select({ id: domains.id })
    .from(domains)
    .where(and(eq(domains.connectionId, connectionId), eq(domains.name, domain)));
  if (!owned) throw new Error("That domain isn't part of this connection");
  let waiting = false;
  await guarded(connectionId, () => provider.setReceiving(domain, on)).catch((error: unknown) => {
    if (!(on && error instanceof BirdError && (error.status === 409 || error.status === 422))) throw error;
    waiting = true;
  });
  const bird = connection.config.bird!;
  const receiving = new Set(bird.receiving);
  const pending = new Set(bird.pending ?? []);
  if (on && !waiting) receiving.add(domain);
  if (on && waiting) pending.add(domain);
  if (!on) {
    receiving.delete(domain);
    pending.delete(domain);
  }
  provider.target.receiving = [...receiving];
  provider.target.pending = [...pending];
  await db
    .update(connections)
    .set({ config: { ...connection.config, bird: { ...bird, receiving: [...receiving], pending: [...pending] } } })
    .where(eq(connections.id, connectionId));
  await syncDomains(connectionId, workspaceId, await domainLimitFor(workspaceId));
  if (!on) return { mx: null, waiting: false };
  const records = (await provider.domainRecords(domain)).filter((record) => record.type === "MX");
  return { mx: await withDns(connection, null, domain, records), waiting };
}

// Tries again to turn on receiving for the domains waiting on Bird. Returns whether none
// are left waiting.
export async function activatePendingBirdReceiving(connectionId: string) {
  const db = getDb();
  const connection = await loadConnection(connectionId);
  const bird = connection.config.bird;
  if (connection.provider !== "bird" || connection.status !== "active" || !bird?.pending?.length) return true;
  const provider = birdProviderFor(connection);
  const receiving = new Set(bird.receiving);
  const pending = new Set(bird.pending);
  for (const domain of bird.pending) {
    try {
      await provider.setReceiving(domain, true);
      receiving.add(domain);
      pending.delete(domain);
    } catch (error) {
      if (!(error instanceof BirdError && (error.status === 409 || error.status === 422))) {
        await markIfRoleRevoked(connectionId, error);
        throw error;
      }
    }
  }
  if (pending.size !== bird.pending.length) {
    await db
      .update(connections)
      .set({ config: { ...connection.config, bird: { ...bird, receiving: [...receiving], pending: [...pending] } } })
      .where(eq(connections.id, connectionId));
    await syncDomains(connectionId, connection.workspaceId, await domainLimitFor(connection.workspaceId));
  }
  return pending.size === 0;
}

// Webhook

type WebhookResult = { status: number };

interface WebhookSteps {
  load(connectionId: string): Promise<{ secret: string } | null>;
  // Saves the event, safe to repeat: Bird retries with the same webhook-id.
  save(connectionId: string, providerEventId: string, type: string, emailId: string, payload: Record<string, unknown>): Promise<void>;
  ingest(connectionId: string, emailId: string): Promise<unknown>;
  recordDelivery(connectionId: string, type: string, emailId: string, detail: { recipients: string[]; reason?: string }): Promise<unknown>;
}

const webhookSteps: WebhookSteps = {
  load: async (connectionId) => {
    const connection = await loadConnection(connectionId).catch(() => null);
    if (!connection || connection.provider !== "bird" || !connection.webhookSecretEnc) return null;
    return { secret: decrypt(connection.webhookSecretEnc) };
  },
  save: async (connectionId, providerEventId, type, emailId, payload) => {
    await getDb().insert(webhookEvents).values({ connectionId, providerEventId, type, emailId, payload }).onConflictDoNothing();
  },
  ingest: enqueueIngest,
  recordDelivery: recordDeliveryEvent,
};

// Delivery events and received mail, signed the Standard Webhooks way. Bird keeps
// received mail for 30 days, so the event only names it: ingest fetches the raw message,
// and backfill finds any event that never arrived.
export async function handleBirdWebhook(
  connectionId: string,
  input: { id: string | null; timestamp: string | null; signature: string | null; body: Uint8Array },
  steps: WebhookSteps = webhookSteps,
  now = Date.now(),
): Promise<WebhookResult> {
  const connection = await steps.load(connectionId);
  if (!connection) return { status: 404 };
  if (!verifyBirdSignature(connection.secret, input, now)) return { status: 401 };
  let event: BirdEvent;
  try {
    event = JSON.parse(new TextDecoder().decode(input.body)) as BirdEvent;
  } catch {
    return { status: 400 };
  }
  const providerEventId = input.id!;
  if (event.type === "email.received") {
    const emailId = event.data?.inbound_message_id;
    if (!emailId) return { status: 200 };
    // The hint is what ingest reads for the recipients.
    await steps.save(connectionId, providerEventId, "email.received", emailId, { hint: birdInboundHint(event) });
    await steps.ingest(connectionId, emailId);
    return { status: 200 };
  }
  const type = birdDeliveryType(event);
  const emailId = event.data?.email_id;
  if (!type || !emailId) return { status: 200 };
  await steps.save(connectionId, providerEventId, type, emailId, event as Record<string, unknown>);
  await steps.recordDelivery(connectionId, type, emailId, birdEventDetail(event));
  return { status: 200 };
}
