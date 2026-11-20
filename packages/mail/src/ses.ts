import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getAwsBrokerEnv, getEnv } from "@hellobox/config";
import { entitlementsFor } from "@hellobox/extensions";
import { connections, domains, getDb, mailboxes, webhookEvents } from "@hellobox/db";
import {
  confirmSubscription,
  INBOUND_PREFIX,
  quickCreateUrl,
  SES_SETUP_OBJECT,
  type Authentication,
  type DnsRecord,
  type SesRegion,
  type SnsMessage,
  type StackCallback,
} from "@hellobox/providers";
import { enqueueIngest } from "@hellobox/queue";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { applyCloudflare, cloudflareStatus, type CloudflareStatus } from "./cloudflare";
import { loadConnection, sesProviderFor, syncDomains } from "./connections";
import { restoreDomain } from "./domains";
import { recordDeliveryEvent } from "./send";

const appUrl = () => getEnv().APP_URL.replace(/\/$/, "");
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export const sesWebhookUrl = (connectionId: string, kind: "events" | "inbound") =>
  `${appUrl()}/api/webhooks/ses/${connectionId}/${kind}`;

// Connecting

// A pending connection plus the CloudFormation link that finishes it. The token and
// external id only ever appear in that link.
export async function startSesConnection(input: { workspaceId: string; region: SesRegion; route53: boolean }) {
  const broker = getAwsBrokerEnv();
  const externalId = randomBytes(24).toString("base64url");
  const connectToken = randomBytes(32).toString("base64url");
  const [connection] = await getDb()
    .insert(connections)
    .values({
      workspaceId: input.workspaceId,
      provider: "ses",
      status: "pending",
      externalId,
      connectTokenHash: hashToken(connectToken),
      config: { region: input.region, route53: input.route53 },
    })
    .returning({ id: connections.id });
  if (!connection) throw new Error("Couldn't start the connection");
  return {
    connectionId: connection.id,
    url: quickCreateUrl({
      region: input.region,
      templatesBaseUrl: broker.AWS_TEMPLATES_BASE_URL,
      connectionId: connection.id,
      externalId,
      connectToken,
      callbackUrl: `${appUrl()}/api/aws/connect`,
      brokerAccountId: broker.AWS_BROKER_ACCOUNT_ID,
      route53: input.route53,
    }),
  };
}

function tokenMatches(stored: string | null, token: string) {
  if (!stored) return false;
  const a = Buffer.from(stored);
  const b = Buffer.from(hashToken(token));
  return a.length === b.length && timingSafeEqual(a, b);
}

// The stack in the customer's account reports in here. Setting things up needs the new
// role, which IAM can take a few seconds to make usable, so that happens in a job.
export async function handleStackCallback(callback: StackCallback, enqueueProvision: (id: string) => Promise<unknown>) {
  const db = getDb();
  const [connection] = await db.select().from(connections).where(eq(connections.id, callback.connectionId));
  if (!connection || connection.provider !== "ses" || !tokenMatches(connection.connectTokenHash, callback.connectToken)) {
    return { ok: false as const };
  }
  if (callback.requestType === "Delete") {
    await db.update(connections).set({ status: "disconnected" }).where(eq(connections.id, connection.id));
    return { ok: true as const };
  }
  if (callback.region !== connection.config.region) return { ok: false as const };
  await db
    .update(connections)
    .set({
      status: "pending",
      config: { ...connection.config, roleArn: callback.roleArn, accountId: callback.accountId },
    })
    .where(eq(connections.id, connection.id));
  await enqueueProvision(connection.id);
  return { ok: true as const };
}

// Creates the configuration set and event topic, then imports the account's domains.
// Runs again safely, so it also repairs a half-finished connection.
export async function provisionSesConnection(connectionId: string) {
  const db = getDb();
  const connection = await loadConnection(connectionId);
  if (connection.provider !== "ses" || connection.status === "disconnected") return { status: "skipped" as const };
  const provider = sesProviderFor(connection);
  const eventsTopicArn = await provider.ensureEvents(sesWebhookUrl(connectionId, "events"));
  await db
    .update(connections)
    .set({ status: "active", config: { ...connection.config, eventsTopicArn } })
    .where(eq(connections.id, connectionId));
  await syncDomains(connectionId, connection.workspaceId, await domainLimitFor(connection.workspaceId));
  return { status: "active" as const };
}

async function activeSes(connectionId: string, workspaceId: string) {
  const connection = await loadConnection(connectionId);
  if (connection.workspaceId !== workspaceId || connection.provider !== "ses") {
    throw new Error("AWS connection not found");
  }
  if (connection.status !== "active") throw new Error("This AWS connection isn't active. Reconnect it first.");
  return { connection, provider: sesProviderFor(connection) };
}

export async function sesAccountStatus(connectionId: string, workspaceId: string) {
  const { provider } = await activeSes(connectionId, workspaceId);
  return provider.accountStatus();
}

export async function requestSesProductionAccess(
  connectionId: string,
  workspaceId: string,
  request: Parameters<ReturnType<typeof sesProviderFor>["requestProductionAccess"]>[0],
) {
  const { provider } = await activeSes(connectionId, workspaceId);
  await provider.requestProductionAccess(request);
}

// A starting point for the "How you'll use SES" text in a production access request. It
// only states what HelloBox really sets up for this connection, so it stays honest when
// the person edits it.
export function buildSesUseCase(input: { mailType: "MARKETING" | "TRANSACTIONAL"; domains: string[] }) {
  const domains = input.domains.length
    ? `from our verified domain${input.domains.length === 1 ? "" : "s"} ${input.domains.join(", ")}`
    : "from domains we verify in SES with DKIM";
  const what =
    input.mailType === "TRANSACTIONAL"
      ? `We send transactional email ${domains}: replies to customers who wrote to us. A person on our team writes and sends each one from HelloBox, a shared inbox connected to our own SES account.`
      : `We send email ${domains} through HelloBox, a shared inbox connected to our own SES account: replies to customers who wrote to us, and newsletters and announcements to contacts who signed up to hear from us.`;
  return [
    what,
    "Bounces and complaints: our configuration set publishes delivery, bounce, complaint and reject events to Amazon SNS. A permanent bounce or a complaint adds the address to a suppression list automatically, and we don't send to it again. Transient bounces are retried by SES as usual.",
    "Campaigns: every campaign email has an unsubscribe link and a one-click List-Unsubscribe header, and opt-outs are honored automatically.",
    "Lists: we only email people who contacted us, are our customers, or signed up. We don't use purchased or rented lists.",
  ].join("\n\n");
}

export async function sesUseCaseDraft(connectionId: string, workspaceId: string, mailType: "MARKETING" | "TRANSACTIONAL") {
  await activeSes(connectionId, workspaceId);
  const verified = await getDb()
    .select({ name: domains.name })
    .from(domains)
    .where(and(eq(domains.connectionId, connectionId), eq(domains.status, "verified"), isNull(domains.removedAt)));
  return buildSesUseCase({ mailType, domains: verified.map((row) => row.name).sort() });
}

export async function sesTestRecipients(connectionId: string, workspaceId: string) {
  const { provider } = await activeSes(connectionId, workspaceId);
  // Opening the list is how people check for a confirmed link, so the composer should
  // see the same answer straight away.
  forgetSandboxState(connectionId);
  return provider.testRecipients();
}

export async function addSesTestRecipient(connectionId: string, workspaceId: string, email: string) {
  const { provider } = await activeSes(connectionId, workspaceId);
  await provider.addTestRecipient(email.trim().toLowerCase());
  forgetSandboxState(connectionId);
}

// The sandbox check runs on every recipient change in the composer, so what AWS says
// about an account is reused for a minute.
const SANDBOX_CACHE_MS = 60_000;
const sandboxCache = new Map<string, { at: number; sandbox: boolean; emails: Set<string>; domains: Set<string> }>();

async function sandboxState(connection: Awaited<ReturnType<typeof loadConnection>>) {
  const cached = sandboxCache.get(connection.id);
  if (cached && Date.now() - cached.at < SANDBOX_CACHE_MS) return cached;
  const provider = sesProviderFor(connection);
  const account = await provider.accountStatus();
  const state = { at: Date.now(), sandbox: !account.productionAccess, emails: new Set<string>(), domains: new Set<string>() };
  if (state.sandbox) {
    const [recipients, domainList] = await Promise.all([provider.testRecipients(), provider.listDomains()]);
    for (const recipient of recipients) if (recipient.verified) state.emails.add(recipient.email);
    for (const domain of domainList) if (domain.status === "verified") state.domains.add(domain.name);
  }
  sandboxCache.set(connection.id, state);
  return state;
}

// Recipients a sandboxed SES account can't deliver to. Empty for Resend, for accounts
// with production access, and when AWS can't be asked (sending then reports the error).
export async function sandboxBlockedRecipients(mailboxId: string, recipients: string[]) {
  const [row] = await getDb()
    .select({ connectionId: domains.connectionId })
    .from(mailboxes)
    .innerJoin(domains, eq(domains.id, mailboxes.domainId))
    .where(eq(mailboxes.id, mailboxId));
  if (!row) return [];
  const connection = await loadConnection(row.connectionId);
  if (connection.provider !== "ses" || connection.status !== "active") return [];
  const state = await sandboxState(connection).catch(() => null);
  if (!state?.sandbox) return [];
  return recipients.filter((value) => {
    const address = (value.match(/<([^>]+)>/)?.[1] ?? value).trim().toLowerCase();
    return !state.emails.has(address) && !state.domains.has(address.slice(address.indexOf("@") + 1));
  });
}

export function forgetSandboxState(connectionId: string) {
  sandboxCache.delete(connectionId);
}

// Domains

// How many domains the workspace may have on: unlimited unless billing says otherwise.
export async function domainLimitFor(workspaceId: string) {
  return (await entitlementsFor(workspaceId)).limits.domains;
}

export type DnsHost = "route53" | "cloudflare";

export interface DomainSetup {
  records: DnsRecord[];
  // What was written to the DNS host, when we may write there.
  applied: DnsRecord[];
  skipped: DnsRecord[];
  appliedTo: DnsHost | null;
  // Whether Route 53 has the domain, when the connection may write there.
  zoneFound: boolean | null;
  cloudflare: CloudflareStatus;
}

// Writes the records wherever we're allowed to: Route 53 when the connection may and has
// the zone, otherwise Cloudflare when the domain is there and the workspace connected it.
export async function withDns(
  connection: Awaited<ReturnType<typeof loadConnection>>,
  // Only SES can write to Route 53.
  provider: Pick<ReturnType<typeof sesProviderFor>, "applyRoute53"> | null,
  domain: string,
  records: DnsRecord[],
  only?: DnsHost,
): Promise<DomainSetup> {
  const cloudflare = await cloudflareStatus(connection.workspaceId, domain);
  const setup: DomainSetup = { records, applied: [], skipped: [], appliedTo: null, zoneFound: null, cloudflare };
  if (provider && connection.config.route53 && only !== "cloudflare") {
    const result = await provider.applyRoute53(domain, records);
    setup.zoneFound = result.zone !== null;
    if (result.zone) return { ...setup, applied: result.applied, skipped: result.skipped, appliedTo: "route53" };
  }
  if (cloudflare.onCloudflare && cloudflare.connected && only !== "route53") {
    const result = await applyCloudflare(connection.workspaceId, domain, records);
    if (!result) return { ...setup, cloudflare: { ...cloudflare, connected: false } };
    if (result.zone) return { ...setup, applied: result.applied, skipped: result.skipped, appliedTo: "cloudflare" };
  }
  return setup;
}

export function normalizeDomain(name: string) {
  const domain = name.trim().toLowerCase().replace(/\.$/, "");
  if (!/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(domain)) {
    throw new Error("Enter a domain like example.com");
  }
  return domain;
}

// Imports a domain just added at the provider. Adding one that was removed in HelloBox
// brings it back.
export async function importAddedDomain(connectionId: string, workspaceId: string, domain: string) {
  const domainLimit = await domainLimitFor(workspaceId);
  await syncDomains(connectionId, workspaceId, domainLimit);
  const [existing] = await getDb()
    .select({ id: domains.id })
    .from(domains)
    .where(and(eq(domains.connectionId, connectionId), eq(domains.name, domain)));
  if (existing) await restoreDomain(existing.id, workspaceId, domainLimit);
}

export async function addSesDomain(connectionId: string, workspaceId: string, name: string) {
  const { connection, provider } = await activeSes(connectionId, workspaceId);
  const domain = normalizeDomain(name);
  const records = await provider.addDomain(domain);
  const setup = await withDns(connection, provider, domain, records);
  await importAddedDomain(connectionId, workspaceId, domain);
  return setup;
}

export async function sesDomainSetup(connectionId: string, workspaceId: string, domain: string) {
  const { connection, provider } = await activeSes(connectionId, workspaceId);
  const [records, zoneFound, cloudflare] = await Promise.all([
    provider.domainRecords(domain),
    connection.config.route53 ? provider.hasRoute53Zone(domain) : Promise.resolve(null),
    cloudflareStatus(workspaceId, domain),
  ]);
  return { records, zoneFound, cloudflare };
}

export async function applySesDomainDns(connectionId: string, workspaceId: string, domain: string, host: DnsHost) {
  const { connection, provider } = await activeSes(connectionId, workspaceId);
  return withDns(connection, provider, domain, await provider.domainRecords(domain), host);
}

// Receiving

// Points SES receiving for these domains at us. Turning a domain off removes it from
// the rule; the last one removes the rule itself.
export async function setSesReceiving(connectionId: string, workspaceId: string, domainNames: string[]) {
  const db = getDb();
  const { connection, provider } = await activeSes(connectionId, workspaceId);
  const owned = await db
    .select({ name: domains.name })
    .from(domains)
    .where(and(eq(domains.connectionId, connectionId), inArray(domains.name, domainNames.length ? domainNames : [""])));
  const names = owned.map((row) => row.name);
  if (names.length !== domainNames.length) throw new Error("One of those domains isn't part of this connection");

  if (!connection.config.receiving) {
    if (!names.length) return { mx: [] as DomainSetup[] };
    const receiving = await provider.enableReceiving({
      connectionId,
      endpoint: sesWebhookUrl(connectionId, "inbound"),
      domains: names,
    });
    await db
      .update(connections)
      .set({ config: { ...connection.config, receiving } })
      .where(eq(connections.id, connectionId));
  } else {
    await provider.setReceivingDomains(names);
    if (!names.length) {
      const { receiving: _removed, ...rest } = connection.config;
      await db.update(connections).set({ config: rest }).where(eq(connections.id, connectionId));
    }
  }
  await syncDomains(connectionId, workspaceId, await domainLimitFor(workspaceId));

  // MX records for each domain, written to the DNS host where allowed.
  const mx: DomainSetup[] = [];
  for (const name of names) {
    const records = (await provider.domainRecords(name)).filter((record) => record.type === "MX");
    mx.push(await withDns(connection, provider, name, records));
  }
  return { mx };
}

// Notifications

interface ReceivedNotification {
  notificationType: "Received";
  receipt: {
    recipients?: string[];
    spfVerdict?: { status?: string };
    dkimVerdict?: { status?: string };
    dmarcVerdict?: { status?: string };
    action?: { type?: string; objectKey?: string; bucketName?: string };
  };
  mail?: { messageId?: string };
}

export interface SendingEvent {
  eventType: "Delivery" | "Bounce" | "Complaint" | "Reject" | "DeliveryDelay" | string;
  mail?: { messageId?: string; destination?: string[]; tags?: Record<string, string[]> };
  delivery?: { recipients?: string[] };
  bounce?: {
    bounceType?: string;
    bounceSubType?: string;
    bouncedRecipients?: { emailAddress?: string; diagnosticCode?: string }[];
  };
  complaint?: { complaintFeedbackType?: string; complainedRecipients?: { emailAddress?: string }[] };
  reject?: { reason?: string };
  deliveryDelay?: { delayType?: string; delayedRecipients?: { emailAddress?: string; diagnosticCode?: string }[] };
}

const verdict = (value?: { status?: string }) => value?.status?.toLowerCase();

function authenticationOf(receipt: ReceivedNotification["receipt"]): Authentication {
  const result: Authentication = {};
  const spf = verdict(receipt.spfVerdict);
  const dkim = verdict(receipt.dkimVerdict);
  const dmarc = verdict(receipt.dmarcVerdict);
  if (spf) result.spf = spf;
  if (dkim) result.dkim = dkim;
  if (dmarc) result.dmarc = dmarc;
  return result;
}

// SES event types, mapped onto the delivery statuses the inbox already shows.
export function deliveryType(event: SendingEvent) {
  switch (event.eventType) {
    case "Delivery":
      return "email.delivered";
    case "Bounce":
      return event.bounce?.bounceType === "Permanent" ? "email.bounced" : "email.delivery_delayed";
    case "Complaint":
      return "email.complained";
    case "Reject":
      return "email.failed";
    case "DeliveryDelay":
      return "email.delivery_delayed";
    default:
      return null;
  }
}

const addresses = (list?: { emailAddress?: string }[]) =>
  (list ?? []).flatMap((entry) => (entry.emailAddress ? [entry.emailAddress.toLowerCase()] : []));

// Who an SES event is about, and what the receiving server said.
export function sesEventDetail(event: SendingEvent): { recipients: string[]; reason?: string } {
  switch (event.eventType) {
    case "Bounce": {
      const bounced = event.bounce?.bouncedRecipients ?? [];
      const reason = bounced.find((entry) => entry.diagnosticCode)?.diagnosticCode ?? event.bounce?.bounceSubType;
      return { recipients: addresses(bounced), reason };
    }
    case "Complaint":
      return { recipients: addresses(event.complaint?.complainedRecipients), reason: event.complaint?.complaintFeedbackType };
    case "Delivery":
      return { recipients: (event.delivery?.recipients ?? []).map((value) => value.toLowerCase()) };
    case "DeliveryDelay": {
      const delayed = event.deliveryDelay?.delayedRecipients ?? [];
      return { recipients: addresses(delayed), reason: delayed.find((entry) => entry.diagnosticCode)?.diagnosticCode ?? event.deliveryDelay?.delayType };
    }
    case "Reject":
      return { recipients: [], reason: event.reject?.reason };
    default:
      return { recipients: [] };
  }
}

// Verified SNS messages for a connection's topics. Only the topics we created for this
// connection count, so a valid message from some other topic is ignored.
export async function handleSesNotification(connectionId: string, kind: "events" | "inbound", message: SnsMessage) {
  const db = getDb();
  const connection = await loadConnection(connectionId).catch(() => null);
  if (!connection || connection.provider !== "ses") return { status: 404 };
  const expected = kind === "events" ? connection.config.eventsTopicArn : connection.config.receiving?.topicArn;
  // Before setup finishes, the topic ARN isn't stored yet, but it must be in the account.
  const topicOk = expected
    ? message.TopicArn === expected
    : connection.config.accountId !== undefined && message.TopicArn.split(":")[4] === connection.config.accountId;
  if (!topicOk) return { status: 403 };

  if (message.Type === "SubscriptionConfirmation") {
    await confirmSubscription(message);
    return { status: 204 };
  }
  if (message.Type !== "Notification") return { status: 204 };

  const payload = JSON.parse(message.Message) as ReceivedNotification | SendingEvent;
  if (kind === "inbound" && "notificationType" in payload && payload.notificationType === "Received") {
    const key = payload.receipt.action?.objectKey ?? "";
    const emailId = key.startsWith(INBOUND_PREFIX) ? key.slice(INBOUND_PREFIX.length) : key;
    if (!emailId || emailId === SES_SETUP_OBJECT) return { status: 204 };
    // Saved before anything else, so a queue outage can't lose the email. Backfill
    // also finds it in the bucket.
    await db
      .insert(webhookEvents)
      .values({
        connectionId,
        providerEventId: message.MessageId,
        type: "email.received",
        emailId,
        payload: {
          hint: { recipients: payload.receipt.recipients ?? [], authentication: authenticationOf(payload.receipt) },
          receipt: payload.receipt,
        },
      })
      .onConflictDoNothing();
    await enqueueIngest(connectionId, emailId);
    return { status: 204 };
  }

  if (kind === "events" && "eventType" in payload) {
    const messageId = payload.mail?.messageId;
    const type = deliveryType(payload);
    if (!messageId || !type) return { status: 204 };
    await db
      .insert(webhookEvents)
      .values({ connectionId, providerEventId: message.MessageId, type, emailId: messageId, payload })
      .onConflictDoNothing();
    // A hard bounce or complaint suppresses the address, campaign or not, and the
    // suppression list says why.
    await recordDeliveryEvent(connectionId, type, messageId, sesEventDetail(payload));
  }
  return { status: 204 };
}
