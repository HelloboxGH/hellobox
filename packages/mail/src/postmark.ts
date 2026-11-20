import { randomBytes } from "node:crypto";
import { decrypt, encrypt, getEnv } from "@hellobox/config";
import { connections, domains, getDb, webhookEvents } from "@hellobox/db";
import {
  checkBasicAuth,
  isPostmarkMissingMx,
  PostmarkAccount,
  postmarkDeliveryType,
  postmarkEventDetail,
  postmarkInboundHint,
  postmarkInboundMx,
  postmarkInboundRaw,
  withBasicAuth,
  type PostmarkEvent,
  type PostmarkInbound,
  type PostmarkServer,
} from "@hellobox/providers";
import { and, eq } from "drizzle-orm";
import { enqueuePostmarkInbound } from "@hellobox/queue";
import { cloudflareStatus } from "./cloudflare";
import { loadConnection, markIfRoleRevoked, postmarkProviderFor, syncDomains } from "./connections";
import { receivePushedEmail } from "./pushed";
import { recordDeliveryEvent } from "./send";
import { importAddedDomain, normalizeDomain, domainLimitFor, withDns, type DnsHost } from "./ses";

type Connection = Awaited<ReturnType<typeof loadConnection>>;

const SERVER_NAME = "HelloBox";

const appUrl = () => getEnv().APP_URL.replace(/\/$/, "");

export const postmarkWebhookUrl = (connectionId: string, kind: "inbound" | "events") =>
  `${appUrl()}/api/webhooks/postmark/${connectionId}/${kind}`;

// Connecting

const serverSummary = (server: PostmarkServer) => ({
  id: server.ID,
  name: server.Name,
  inboundDomain: server.InboundDomain || null,
  // Another inbound hook means the server already sends its mail somewhere else.
  hasOtherHook: Boolean(server.InboundHookUrl) && !server.InboundHookUrl.includes("/api/webhooks/postmark/"),
});

// The first step: checks the token and shows which servers it can use.
export async function listPostmarkServers(token: string) {
  const servers = await new PostmarkAccount(token).listServers();
  return servers.map(serverSummary);
}

// Saves the connection, points the server's inbound hook at us with the raw email
// included, adds the event webhook and imports the account's domains. Given an existing
// connection, it reconnects that one instead. Safe to run again.
export async function connectPostmark(input: {
  workspaceId: string;
  token: string;
  // A server id, or "new" for a server named HelloBox.
  server: number | "new";
  connectionId?: string;
}) {
  const db = getDb();
  const account = new PostmarkAccount(input.token);
  let server: PostmarkServer;
  if (input.server === "new") {
    const existing = (await account.listServers()).find((candidate) => candidate.Name === SERVER_NAME);
    server = existing ? await account.getServer(existing.ID) : await account.createServer(SERVER_NAME);
  } else {
    server = await account.getServer(input.server);
  }
  const serverToken = server.ApiTokens[0];
  if (!serverToken) throw new Error("This Postmark server has no API token. Add one in Postmark, then try again.");

  const linked = await db
    .select({ id: connections.id, status: connections.status, config: connections.config })
    .from(connections)
    .where(and(eq(connections.workspaceId, input.workspaceId), eq(connections.provider, "postmark")));
  const sameServer = linked.find((row) => row.status !== "disconnected" && row.config.postmark?.serverId === server.ID);
  if (sameServer && sameServer.id !== input.connectionId) {
    throw new Error(`The ${server.Name} server is already connected to this workspace`);
  }
  const reconnecting = input.connectionId ? linked.find((row) => row.id === input.connectionId) : undefined;
  if (input.connectionId && !reconnecting) throw new Error("Postmark connection not found");

  const password = randomBytes(24).toString("base64url");
  const config = {
    postmark: { serverId: server.ID, serverName: server.Name, inboundDomain: server.InboundDomain || undefined },
  };
  const values = {
    status: "pending" as const,
    config,
    accessTokenEnc: encrypt(input.token),
    secondaryTokenEnc: encrypt(serverToken),
    webhookSecretEnc: encrypt(password),
  };
  let connectionId: string;
  if (reconnecting) {
    await db.update(connections).set(values).where(eq(connections.id, reconnecting.id));
    connectionId = reconnecting.id;
  } else {
    const [row] = await db
      .insert(connections)
      .values({ workspaceId: input.workspaceId, provider: "postmark", ...values })
      .returning({ id: connections.id });
    if (!row) throw new Error("Couldn't save the connection");
    connectionId = row.id;
  }

  const provider = postmarkProviderFor(await loadConnection(connectionId));
  await provider.setInboundDomain(server.InboundDomain || null, withBasicAuth(postmarkWebhookUrl(connectionId, "inbound"), password));
  const webhookId = await provider.server.ensureEventsWebhook(postmarkWebhookUrl(connectionId, "events"), password);
  await db
    .update(connections)
    .set({ status: "active", webhookId: String(webhookId) })
    .where(eq(connections.id, connectionId));
  await syncDomains(connectionId, input.workspaceId, await domainLimitFor(input.workspaceId));
  return { connectionId, serverName: server.Name };
}

async function activePostmark(connectionId: string, workspaceId: string) {
  const connection = await loadConnection(connectionId);
  if (connection.workspaceId !== workspaceId || connection.provider !== "postmark") {
    throw new Error("Postmark connection not found");
  }
  if (connection.status !== "active") throw new Error("This Postmark connection isn't active. Reconnect it first.");
  return { connection, provider: postmarkProviderFor(connection) };
}

// Calls Postmark, and marks the connection when the token stopped working.
async function guarded<T>(connectionId: string, work: () => Promise<T>) {
  try {
    return await work();
  } catch (error) {
    await markIfRoleRevoked(connectionId, error);
    throw error;
  }
}

// Domains

export async function addPostmarkDomain(connectionId: string, workspaceId: string, name: string) {
  const { connection, provider } = await activePostmark(connectionId, workspaceId);
  const domain = normalizeDomain(name);
  const records = await guarded(connectionId, () => provider.addDomain(domain));
  const setup = await withDns(connection, null, domain, records);
  await importAddedDomain(connectionId, workspaceId, domain);
  return setup;
}

export async function postmarkDomainSetup(connectionId: string, workspaceId: string, domain: string) {
  const { provider } = await activePostmark(connectionId, workspaceId);
  const [records, cloudflare] = await Promise.all([
    guarded(connectionId, () => provider.domainRecords(domain)),
    cloudflareStatus(workspaceId, domain),
  ]);
  return { records, zoneFound: null, cloudflare };
}

export async function applyPostmarkDomainDns(connectionId: string, workspaceId: string, domain: string, host: DnsHost) {
  const { connection, provider } = await activePostmark(connectionId, workspaceId);
  return withDns(connection, null, domain, await guarded(connectionId, () => provider.domainRecords(domain)), host);
}

// Receiving

// A Postmark server receives for one domain. Turning it on for another domain is refused
// until the current one is off; null turns it off.
//
// Postmark only takes an inbound domain whose MX already points at it, so the MX record is
// written first. When Postmark can't see it yet, the domain waits as pending and is tried
// again every minute (see activatePendingPostmarkInbound).
export async function setPostmarkReceiving(connectionId: string, workspaceId: string, domain: string | null) {
  const db = getDb();
  const { connection, provider } = await activePostmark(connectionId, workspaceId);
  const postmark = connection.config.postmark!;
  if (domain) {
    const [owned] = await db
      .select({ id: domains.id })
      .from(domains)
      .where(and(eq(domains.connectionId, connectionId), eq(domains.name, domain)));
    if (!owned) throw new Error("That domain isn't part of this connection");
    const current = postmark.inboundDomain ?? postmark.pendingInboundDomain;
    if (current && current !== domain) {
      throw new Error(`A Postmark server receives mail for one domain. Turn receiving off for ${current} first.`);
    }
  }
  const hookUrl = inboundHookUrl(connection);
  if (!domain) {
    await guarded(connectionId, () => provider.setInboundDomain(null, hookUrl));
    await savePostmark(connection, { inboundDomain: undefined, pendingInboundDomain: undefined });
    await syncDomains(connectionId, workspaceId, await domainLimitFor(workspaceId));
    return { mx: null, waiting: false };
  }
  const mx = await withDns(connection, null, domain, [postmarkInboundMx(domain)]);
  const live = await guarded(connectionId, () => tryInboundDomain(provider, domain, hookUrl));
  await savePostmark(connection, live ? { inboundDomain: domain, pendingInboundDomain: undefined } : { pendingInboundDomain: domain });
  if (!live) await enqueuePostmarkInbound(connectionId);
  await syncDomains(connectionId, workspaceId, await domainLimitFor(workspaceId));
  return { mx, waiting: !live };
}

function inboundHookUrl(connection: Connection) {
  const password = connection.webhookSecretEnc ? decrypt(connection.webhookSecretEnc) : null;
  if (!password) throw new Error("This Postmark connection is missing its webhook password. Reconnect it.");
  return withBasicAuth(postmarkWebhookUrl(connection.id, "inbound"), password);
}

async function tryInboundDomain(provider: ReturnType<typeof postmarkProviderFor>, domain: string, hookUrl: string) {
  try {
    await provider.setInboundDomain(domain, hookUrl);
    return true;
  } catch (error) {
    if (isPostmarkMissingMx(error)) return false;
    throw error;
  }
}

async function savePostmark(connection: Connection, patch: Partial<NonNullable<Connection["config"]["postmark"]>>) {
  const postmark = { ...connection.config.postmark!, ...patch };
  await getDb()
    .update(connections)
    .set({ config: { ...connection.config, postmark } })
    .where(eq(connections.id, connection.id));
}

// Tries a pending inbound domain again. True once Postmark took it, or when there's
// nothing waiting any more.
export async function activatePendingPostmarkInbound(connectionId: string) {
  const connection = await loadConnection(connectionId).catch(() => null);
  const pending = connection?.config.postmark?.pendingInboundDomain;
  if (!connection || connection.status !== "active" || !pending) return true;
  const provider = postmarkProviderFor(connection);
  const live = await guarded(connectionId, () => tryInboundDomain(provider, pending, inboundHookUrl(connection)));
  if (!live) return false;
  await savePostmark(connection, { inboundDomain: pending, pendingInboundDomain: undefined });
  await syncDomains(connectionId, connection.workspaceId, await domainLimitFor(connection.workspaceId));
  return true;
}

// Webhooks

type WebhookResult = { status: number };

interface WebhookSteps {
  // The connection's workspace and webhook password, or null when there's no such
  // Postmark connection.
  load(connectionId: string): Promise<{ workspaceId: string; password: string } | null>;
  receive: typeof receivePushedEmail;
  recordEvent(connectionId: string, providerEventId: string, type: string, event: PostmarkEvent & { MessageID: string }): Promise<void>;
}

const webhookSteps: WebhookSteps = {
  load: async (connectionId) => {
    const connection = await loadConnection(connectionId).catch(() => null);
    if (!connection || connection.provider !== "postmark" || !connection.webhookSecretEnc) return null;
    return { workspaceId: connection.workspaceId, password: decrypt(connection.webhookSecretEnc) };
  },
  receive: receivePushedEmail,
  recordEvent: async (connectionId, providerEventId, type, event) => {
    await getDb()
      .insert(webhookEvents)
      .values({ connectionId, providerEventId, type, emailId: event.MessageID, payload: event })
      .onConflictDoNothing();
    await recordDeliveryEvent(connectionId, type, event.MessageID, postmarkEventDetail(event));
  },
};

async function authorized(steps: WebhookSteps, connectionId: string, header: string | null) {
  const connection = await steps.load(connectionId);
  return connection && checkBasicAuth(header, connection.password) ? connection : null;
}

// New mail. The payload is the only full copy, so it's stored before we answer 200.
// Anything that throws becomes a 500, and Postmark tries again.
export async function handlePostmarkInbound(
  connectionId: string,
  authorization: string | null,
  payload: PostmarkInbound,
  steps: WebhookSteps = webhookSteps,
): Promise<WebhookResult> {
  const connection = await authorized(steps, connectionId, authorization);
  if (!connection) return { status: 401 };
  if (!payload.MessageID) return { status: 400 };
  await steps.receive({
    connectionId,
    workspaceId: connection.workspaceId,
    emailId: payload.MessageID,
    providerEventId: `inbound:${payload.MessageID}`,
    raw: await postmarkInboundRaw(payload),
    hint: postmarkInboundHint(payload),
    payload: { from: payload.FromFull?.Email ?? payload.From ?? null, subject: payload.Subject ?? null },
  });
  return { status: 200 };
}

// Delivery, bounce and complaint events. Postmark posts a test event to verify the
// webhook, so anything we don't recognise still gets a 200.
export async function handlePostmarkEvent(
  connectionId: string,
  authorization: string | null,
  traceId: string | null,
  event: PostmarkEvent,
  steps: WebhookSteps = webhookSteps,
): Promise<WebhookResult> {
  if (!(await authorized(steps, connectionId, authorization))) return { status: 401 };
  const type = postmarkDeliveryType(event);
  if (!type || !event.MessageID) return { status: 200 };
  // The trace id stays the same across retries.
  const providerEventId = traceId ?? `${event.RecordType}:${event.ID ?? event.MessageID}`;
  await steps.recordEvent(connectionId, providerEventId, type, { ...event, MessageID: event.MessageID });
  return { status: 200 };
}
