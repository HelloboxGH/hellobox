import { randomBytes, timingSafeEqual } from "node:crypto";
import { decrypt, encrypt, getEnv } from "@hellobox/config";
import { connections, getDb, webhookEvents } from "@hellobox/db";
import {
  checkSpec,
  customEventsFrom,
  CustomError,
  CustomProvider,
  maskSecrets,
  TemplateError,
  verifyCustomEvent,
  type CustomEvent,
  type CustomResponse,
  type CustomSpec,
} from "@hellobox/providers";
import { eq } from "drizzle-orm";
import { cloudflareStatus } from "./cloudflare";
import { customHttp, loadConnection, loadSpec, syncDomains } from "./connections";
import { recordDeliveryEvent } from "./send";
import { domainLimitFor, importAddedDomain, normalizeDomain, type DomainSetup } from "./ses";

type Connection = typeof connections.$inferSelect;

const appUrl = () => getEnv().APP_URL.replace(/\/$/, "");

// Where the provider posts delivery events. The key is ours, so even a provider that
// doesn't sign its webhooks can't be imitated by someone who only knows the connection id.
export const customWebhookUrl = (connectionId: string, token: string) =>
  `${appUrl()}/api/webhooks/custom/${connectionId}?key=${encodeURIComponent(token)}`;

// What's wrong with a spec and its values, before anything is saved: the spec's shape,
// then a value for each <NAME>. Values for names the spec no longer uses are dropped.
export function customSpecProblems(spec: unknown, values: Record<string, string>) {
  const check = checkSpec(spec);
  if (!check.ok) return { problems: check.problems } as const;
  const missing = check.secrets.filter((name) => !values[name]?.trim());
  if (missing.length) return { problems: missing.map((name) => `Enter a value for <${name}>`) } as const;
  return { spec: check.spec, secrets: Object.fromEntries(check.secrets.map((name) => [name, values[name]!])) } as const;
}

// The values to use: the ones typed, and for those left empty, what this connection saved.
async function valuesFor(workspaceId: string, values: Record<string, string>, connectionId?: string) {
  let previous: Connection | undefined;
  if (connectionId) {
    previous = await loadConnection(connectionId).catch(() => undefined);
    if (!previous || previous.workspaceId !== workspaceId || previous.provider !== "custom") {
      throw new Error("Custom provider not found");
    }
  }
  const saved = previous?.accessTokenEnc ? (JSON.parse(decrypt(previous.accessTokenEnc)) as Record<string, string>) : {};
  return { previous, values: { ...saved, ...Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim())) } };
}

// Sends one real email with a spec before it's saved, to the person testing, and shows what
// the provider answered. Their values are masked in the answer.
export async function testCustomSend(input: {
  workspaceId: string;
  spec: unknown;
  values: Record<string, string>;
  connectionId?: string;
  from: string;
  to: string;
}) {
  const { values } = await valuesFor(input.workspaceId, input.values, input.connectionId);
  const checked = customSpecProblems(input.spec, values);
  if ("problems" in checked) throw new CustomError(checked.problems!.join("\n"));
  const domain = input.from.split("@")[1]?.replace(/>$/, "") || "hellobox.app";
  let answered: CustomResponse | null = null;
  const provider = new CustomProvider({ spec: checked.spec, secrets: checked.secrets, domains: [] }, async (request) => {
    answered = await customHttp(request);
    return answered;
  });
  const message = {
    from: input.from,
    to: [input.to],
    subject: `Test from HelloBox: ${checked.spec.name}`,
    html: `<p>This test was sent through ${checked.spec.name} with your custom provider spec. It works.</p>`,
    text: `This test was sent through ${checked.spec.name} with your custom provider spec. It works.`,
    headers: { "Message-ID": `<test-${crypto.randomUUID()}@${domain}>` },
  };
  let id: string | null = null;
  let error: string | null = null;
  try {
    id = (await provider.send(message, crypto.randomUUID())).id;
  } catch (failure) {
    if (!answered) throw failure instanceof TemplateError ? new CustomError(failure.message) : failure;
    error = failure instanceof Error ? failure.message : String(failure);
  }
  const response = answered as CustomResponse | null;
  const path = checked.spec.send.response?.id;
  return {
    ok: !error,
    status: response?.status ?? 0,
    body: maskSecrets((response?.body ?? "").slice(0, 2000), checked.secrets),
    id,
    // Set when the spec says where the id is: whether it was there.
    idFound: path ? Boolean(id && id !== message.headers["Message-ID"].replace(/^<|>$/g, "")) : null,
    error,
  };
}

// Connecting

// Saves the spec and seals its values. Given an existing connection, it updates that one:
// values left empty keep what was saved for the same name, and typed domains stay. A spec
// that lists domains is tried first, so wrong values never become a connection.
export async function connectCustom(input: {
  workspaceId: string;
  spec: unknown;
  values: Record<string, string>;
  connectionId?: string;
}) {
  const { previous, values } = await valuesFor(input.workspaceId, input.values, input.connectionId);
  const checked = customSpecProblems(input.spec, values);
  if ("problems" in checked) throw new CustomError(checked.problems!.join("\n"));

  const row = {
    status: "active" as const,
    // The description and logo stay; setCustomAppearance changes them.
    config: { custom: { ...previous?.config.custom, spec: checked.spec as Record<string, unknown>, domains: previous?.config.custom?.domains ?? [] } },
    accessTokenEnc: encrypt(JSON.stringify(checked.secrets)),
    // Kept on reconnect, so the address pasted into the provider keeps working.
    webhookSecretEnc: previous?.webhookSecretEnc ?? encrypt(randomBytes(32).toString("base64url")),
  };
  if (checked.spec.domains) {
    await new CustomProvider({ spec: checked.spec, secrets: checked.secrets, domains: [] }, customHttp)
      .listDomains()
      .catch((error: unknown) => {
        if (error instanceof TemplateError) throw new CustomError(error.message);
        throw error;
      });
  }

  const db = getDb();
  let connectionId: string;
  if (previous) {
    await db.update(connections).set(row).where(eq(connections.id, previous.id));
    connectionId = previous.id;
  } else {
    const [inserted] = await db
      .insert(connections)
      .values({ workspaceId: input.workspaceId, provider: "custom", ...row })
      .returning({ id: connections.id });
    if (!inserted) throw new Error("Couldn't save the connection");
    connectionId = inserted.id;
  }
  if (checked.spec.domains) await syncDomains(connectionId, input.workspaceId, await domainLimitFor(input.workspaceId));
  return { connectionId };
}

async function activeCustom(connectionId: string, workspaceId: string) {
  const connection = await loadConnection(connectionId);
  if (connection.workspaceId !== workspaceId || connection.provider !== "custom") {
    throw new Error("Custom provider not found");
  }
  if (connection.status !== "active") throw new Error("This custom provider isn't active. Reconnect it first.");
  return connection;
}

// How it looks on its card. undefined keeps a value, null (or empty) removes it. Returns
// the logo it replaced, for the caller to delete.
export async function setCustomAppearance(
  connectionId: string,
  workspaceId: string,
  appearance: { description?: string | null; logo?: string | null },
) {
  const connection = await loadConnection(connectionId).catch(() => null);
  if (!connection || connection.workspaceId !== workspaceId || connection.provider !== "custom" || !connection.config.custom) {
    throw new Error("Custom provider not found");
  }
  const { description: oldDescription, logo: oldLogo, ...custom } = connection.config.custom;
  const description = appearance.description === undefined ? oldDescription : appearance.description?.trim() || undefined;
  const logo = appearance.logo === undefined ? oldLogo : appearance.logo || undefined;
  await getDb()
    .update(connections)
    .set({ config: { ...connection.config, custom: { ...custom, ...(description ? { description } : {}), ...(logo ? { logo } : {}) } } })
    .where(eq(connections.id, connectionId));
  return { replacedLogo: oldLogo && oldLogo !== logo ? oldLogo : null };
}

// Domains

// Typed by the customer, as with SMTP, unless the spec lists them. Receiving with HelloBox
// has its own proof (the _hellobox TXT record) before any mail is taken for the domain.
export async function addCustomDomain(connectionId: string, workspaceId: string, name: string): Promise<DomainSetup> {
  const connection = await activeCustom(connectionId, workspaceId);
  const domain = normalizeDomain(name);
  const custom = connection.config.custom!;
  if (loadSpec(connection.config).domains) {
    throw new Error("This provider lists its own domains. Add the domain there, then check again.");
  }
  if (!custom.domains.includes(domain)) {
    await getDb()
      .update(connections)
      .set({ config: { ...connection.config, custom: { ...custom, domains: [...custom.domains, domain] } } })
      .where(eq(connections.id, connectionId));
  }
  await importAddedDomain(connectionId, workspaceId, domain);
  return customDomainSetup(connectionId, workspaceId, domain);
}

// No records: the provider's own (SPF, DKIM) are set up wherever it says.
export async function customDomainSetup(connectionId: string, workspaceId: string, domain: string): Promise<DomainSetup> {
  await activeCustom(connectionId, workspaceId);
  return { records: [], applied: [], skipped: [], appliedTo: null, zoneFound: null, cloudflare: await cloudflareStatus(workspaceId, domain) };
}

// For editing a saved provider: its spec (which has <NAME>s, never the values) and the
// events address to paste into the provider.
export async function customDetails(connectionId: string, workspaceId: string) {
  const connection = await loadConnection(connectionId).catch(() => null);
  if (!connection || connection.workspaceId !== workspaceId || connection.provider !== "custom") {
    throw new Error("Custom provider not found");
  }
  return {
    spec: connection.config.custom?.spec ?? null,
    description: connection.config.custom?.description ?? null,
    logo: connection.config.custom?.logo ?? null,
    webhookUrl: connection.webhookSecretEnc ? customWebhookUrl(connection.id, decrypt(connection.webhookSecretEnc)) : null,
  };
}

// Delivery events

interface EventSteps {
  load(connectionId: string): Promise<{ token: string; spec: CustomSpec; secrets: Record<string, string> } | null>;
  recordEvent(connectionId: string, event: CustomEvent): Promise<void>;
}

const eventSteps: EventSteps = {
  load: async (connectionId) => {
    const connection = await loadConnection(connectionId).catch(() => null);
    if (!connection || connection.provider !== "custom" || !connection.webhookSecretEnc || !connection.accessTokenEnc) return null;
    return {
      token: decrypt(connection.webhookSecretEnc),
      spec: loadSpec(connection.config),
      secrets: JSON.parse(decrypt(connection.accessTokenEnc)) as Record<string, string>,
    };
  },
  recordEvent: async (connectionId, event) => {
    await getDb()
      .insert(webhookEvents)
      .values({ connectionId, providerEventId: event.eventId, type: event.type, emailId: event.messageId, payload: event.payload })
      .onConflictDoNothing();
    // Safe to repeat: statuses merge per recipient.
    await recordDeliveryEvent(connectionId, event.type, event.messageId, {
      recipients: event.recipient ? [event.recipient] : [],
      ...(event.reason ? { reason: event.reason } : {}),
    });
  },
};

const sameSecret = (given: string | null, expected: string) => {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

// Our key first, then the provider's own signature when the spec has one. A spec without
// events answers 404, so the provider stops trying.
export async function handleCustomEvents(
  connectionId: string,
  input: { key: string | null; headers: Record<string, string>; body: Uint8Array },
  steps: EventSteps = eventSteps,
  now = Date.now(),
): Promise<{ status: number }> {
  const connection = await steps.load(connectionId);
  if (!connection?.spec.events) return { status: 404 };
  if (!sameSecret(input.key, connection.token)) return { status: 401 };
  if (!verifyCustomEvent(connection.spec.events.verify, connection.secrets, input, now)) return { status: 401 };
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(input.body));
  } catch {
    return { status: 400 };
  }
  for (const event of customEventsFrom(connection.spec.events, json)) await steps.recordEvent(connectionId, event);
  return { status: 200 };
}
