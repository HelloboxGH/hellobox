import { encrypt } from "@hellobox/config";
import { connections, getDb } from "@hellobox/db";
import { SmtpError, smtpSettingsProblem, type SmtpPort } from "@hellobox/providers";
import { eq } from "drizzle-orm";
import { cloudflareStatus } from "./cloudflare";
import { loadConnection, smtpProviderFor } from "./connections";
import { UnsafeHostError } from "./safe-url";
import { importAddedDomain, normalizeDomain, type DomainSetup } from "./ses";

// Connecting

// Signs in to the server before anything is saved, so a typo never becomes a connection
// that fails on the first send. Given an existing connection, it reconnects that one and
// keeps its domains.
export async function connectSmtp(input: {
  workspaceId: string;
  host: string;
  port: SmtpPort;
  username: string;
  password: string;
  connectionId?: string;
}) {
  const host = input.host.trim().toLowerCase().replace(/\.$/, "");
  const problem = smtpSettingsProblem({ host, port: input.port });
  if (problem) throw new SmtpError(problem);

  let previous: Awaited<ReturnType<typeof loadConnection>> | undefined;
  if (input.connectionId) {
    previous = await loadConnection(input.connectionId).catch(() => undefined);
    if (!previous || previous.workspaceId !== input.workspaceId || previous.provider !== "smtp") {
      throw new Error("SMTP connection not found");
    }
  }
  const config = {
    smtp: { host, port: input.port, username: input.username, domains: previous?.config.smtp?.domains ?? [] },
  };
  const values = { status: "active" as const, config, accessTokenEnc: encrypt(input.password) };

  // Checked with the settings as they'll be saved.
  await smtpProviderFor({ ...(previous ?? placeholder(input.workspaceId)), ...values })
    .verify()
    .catch((error: unknown) => {
      if (error instanceof UnsafeHostError) throw new SmtpError(error.message);
      throw error;
    });

  const db = getDb();
  if (previous) {
    await db.update(connections).set(values).where(eq(connections.id, previous.id));
    return { connectionId: previous.id };
  }
  const [row] = await db
    .insert(connections)
    .values({ workspaceId: input.workspaceId, provider: "smtp", ...values })
    .returning({ id: connections.id });
  if (!row) throw new Error("Couldn't save the connection");
  return { connectionId: row.id };
}

// A connection row that isn't saved yet, only for checking the settings.
function placeholder(workspaceId: string): typeof connections.$inferSelect {
  const now = new Date();
  return {
    id: "unsaved",
    workspaceId,
    provider: "smtp",
    config: {},
    accessTokenEnc: null,
    refreshTokenEnc: null,
    secondaryTokenEnc: null,
    accessExpiresAt: null,
    scope: null,
    webhookId: null,
    webhookSecretEnc: null,
    externalId: null,
    connectTokenHash: null,
    status: "pending",
    lastBackfillAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

async function activeSmtp(connectionId: string, workspaceId: string) {
  const connection = await loadConnection(connectionId);
  if (connection.workspaceId !== workspaceId || connection.provider !== "smtp") {
    throw new Error("SMTP connection not found");
  }
  if (connection.status !== "active") throw new Error("This SMTP connection isn't active. Reconnect it first.");
  return connection;
}

// Domains

// The server can't list domains, so the customer types them. Nothing is checked here: an
// SMTP server decides for itself what it sends from, and receiving with HelloBox has its
// own proof (the _hellobox TXT record) before any mail is taken for the domain.
export async function addSmtpDomain(connectionId: string, workspaceId: string, name: string): Promise<DomainSetup> {
  const connection = await activeSmtp(connectionId, workspaceId);
  const domain = normalizeDomain(name);
  const smtp = connection.config.smtp!;
  if (!smtp.domains.includes(domain)) {
    await getDb()
      .update(connections)
      .set({ config: { ...connection.config, smtp: { ...smtp, domains: [...smtp.domains, domain] } } })
      .where(eq(connections.id, connectionId));
  }
  await importAddedDomain(connectionId, workspaceId, domain);
  return smtpDomainSetup(connectionId, workspaceId, domain);
}

// No records: the SMTP server's own (SPF, DKIM) are set up wherever the server says.
export async function smtpDomainSetup(connectionId: string, workspaceId: string, domain: string): Promise<DomainSetup> {
  await activeSmtp(connectionId, workspaceId);
  return { records: [], applied: [], skipped: [], appliedTo: null, zoneFound: null, cloudflare: await cloudflareStatus(workspaceId, domain) };
}
