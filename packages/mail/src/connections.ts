import { decrypt, encrypt } from "@hellobox/config";
import { connections, domains, getDb } from "@hellobox/db";
import { getExtensions } from "@hellobox/extensions";
import {
  BirdProvider,
  BrevoProvider,
  checkSpec,
  CustomError,
  CustomProvider,
  isCustomAuthError,
  isBirdAuthError,
  isBrevoAuthError,
  isMailersendAuthError,
  isMailjetAuthError,
  isMailgunAuthError,
  isPostmarkAuthError,
  isSendgridAuthError,
  isSmtpAuthError,
  MailersendProvider,
  MailjetProvider,
  MailgunProvider,
  PROVIDER_INFO,
  PostmarkProvider,
  ResendProvider,
  RoleAccessError,
  SendgridProvider,
  SesProvider,
  SmtpProvider,
  type CustomHttp,
  type CustomSpec,
  type MailProvider,
  type ProviderKind,
} from "@hellobox/providers";
import {
  OAuthGrantError,
  refreshTokens,
  ResendApiError,
  ResendClient,
} from "@hellobox/resend";
import { and, eq, inArray } from "drizzle-orm";
import { fitsPlan } from "./domain-names";
import { claimConflict, countedDomainNames, domainClaims, lockDomainName } from "./domains";
import { requestPublicUrl, resolvePublicHost, UnsafeUrlError } from "./safe-url";

type Connection = typeof connections.$inferSelect;

const REFRESH_MARGIN_MS = 60_000;

// Refresh tokens rotate and replaying one can revoke the grant, so the row lock
// makes sure that only one process ever refreshes a connection at a time.
async function freshAccessToken(connectionId: string) {
  try {
    return await refreshInTransaction(connectionId);
  } catch (error) {
    // Marked after the transaction, which a thrown error rolls back. Marked inside it,
    // the connection stayed active and every job kept retrying a dead grant.
    if (error instanceof OAuthGrantError) await markNeedsReconnect(connectionId);
    throw error;
  }
}

function refreshInTransaction(connectionId: string) {
  return getDb().transaction(async (tx) => {
    const [connection] = await tx
      .select()
      .from(connections)
      .where(eq(connections.id, connectionId))
      .for("update");
    if (!connection) throw new Error("Connection not found");
    if (connection.status !== "active") {
      throw new OAuthGrantError("Connection needs reconnecting");
    }
    if (!connection.accessTokenEnc || !connection.refreshTokenEnc || !connection.accessExpiresAt) {
      throw new Error("This connection doesn't use Resend");
    }
    if (connection.accessExpiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS) {
      return decrypt(connection.accessTokenEnc);
    }
    const tokens = await refreshTokens(decrypt(connection.refreshTokenEnc));
    await tx
      .update(connections)
      .set({
        accessTokenEnc: encrypt(tokens.accessToken),
        refreshTokenEnc: encrypt(tokens.refreshToken),
        accessExpiresAt: tokens.expiresAt,
      })
      .where(eq(connections.id, connectionId));
    return tokens.accessToken;
  });
}

// For Resend-only features, such as Segments and Broadcasts.
export const clientForConnection = (connectionId: string) =>
  new ResendClient(() => freshAccessToken(connectionId));

export function sesProviderFor(connection: Connection) {
  const { region, roleArn, accountId, receiving } = connection.config;
  if (!region || !roleArn || !accountId || !connection.externalId) {
    throw new Error("This AWS connection hasn't finished connecting");
  }
  return new SesProvider({
    connectionId: connection.id,
    region,
    roleArn,
    accountId,
    externalId: connection.externalId,
    receiving,
  });
}

export function postmarkProviderFor(connection: Connection) {
  const { postmark } = connection.config;
  if (!postmark || !connection.accessTokenEnc || !connection.secondaryTokenEnc) {
    throw new Error("This Postmark connection hasn't finished connecting");
  }
  return new PostmarkProvider({
    workspaceId: connection.workspaceId,
    connectionId: connection.id,
    accountToken: decrypt(connection.accessTokenEnc),
    serverToken: decrypt(connection.secondaryTokenEnc),
    serverId: postmark.serverId,
    inboundDomain: postmark.inboundDomain,
    pendingInboundDomain: postmark.pendingInboundDomain,
  });
}

export function mailgunProviderFor(connection: Connection) {
  const { mailgun } = connection.config;
  if (!mailgun || !connection.accessTokenEnc) throw new Error("This Mailgun connection hasn't finished connecting");
  return new MailgunProvider({
    workspaceId: connection.workspaceId,
    connectionId: connection.id,
    apiKey: decrypt(connection.accessTokenEnc),
    region: mailgun.region,
    routes: mailgun.routes,
  });
}

export function sendgridProviderFor(connection: Connection) {
  const { sendgrid } = connection.config;
  if (!sendgrid || !connection.accessTokenEnc) throw new Error("This SendGrid connection hasn't finished connecting");
  return new SendgridProvider({
    workspaceId: connection.workspaceId,
    connectionId: connection.id,
    apiKey: decrypt(connection.accessTokenEnc),
    region: sendgrid.region,
    receiving: sendgrid.receiving,
  });
}

export function brevoProviderFor(connection: Connection) {
  const { brevo } = connection.config;
  if (!brevo || !connection.accessTokenEnc) throw new Error("This Brevo connection hasn't finished connecting");
  return new BrevoProvider({
    workspaceId: connection.workspaceId,
    connectionId: connection.id,
    apiKey: decrypt(connection.accessTokenEnc),
    inbound: brevo.inbound,
  });
}

export function mailersendProviderFor(connection: Connection) {
  const { mailersend } = connection.config;
  if (!mailersend || !connection.accessTokenEnc) throw new Error("This MailerSend connection hasn't finished connecting");
  return new MailersendProvider({
    workspaceId: connection.workspaceId,
    connectionId: connection.id,
    apiKey: decrypt(connection.accessTokenEnc),
    inbound: mailersend.inbound,
  });
}

export function mailjetProviderFor(connection: Connection) {
  const { mailjet } = connection.config;
  if (!mailjet || !connection.accessTokenEnc || !connection.secondaryTokenEnc) throw new Error("This Mailjet connection hasn't finished connecting");
  return new MailjetProvider({
    workspaceId: connection.workspaceId,
    connectionId: connection.id,
    apiKey: decrypt(connection.secondaryTokenEnc),
    secretKey: decrypt(connection.accessTokenEnc),
    inbound: mailjet.inbound,
  });
}

export function birdProviderFor(connection: Connection) {
  const { bird } = connection.config;
  if (!bird || !connection.accessTokenEnc) throw new Error("This Bird connection hasn't finished connecting");
  return new BirdProvider({ apiKey: decrypt(connection.accessTokenEnc), region: bird.region, receiving: bird.receiving, pending: bird.pending ?? [] });
}

export function smtpProviderFor(connection: Connection) {
  const { smtp } = connection.config;
  if (!smtp || !connection.accessTokenEnc) throw new Error("This SMTP connection hasn't finished connecting");
  return new SmtpProvider(
    { host: smtp.host, port: smtp.port, username: smtp.username, password: decrypt(connection.accessTokenEnc), domains: smtp.domains },
    resolvePublicHost,
  );
}

// Every custom request goes through here: a public address, checked as it connects, no
// redirects, 15 seconds and a 1 MB answer at most. Logs keep only the method and host.
export const customHttp: CustomHttp = async (request) => {
  const started = Date.now();
  try {
    const response = await requestPublicUrl(request);
    console.info(`[custom] ${request.method} ${new URL(request.url).host} ${response.status} ${Date.now() - started}ms`);
    return response;
  } catch (error) {
    if (error instanceof UnsafeUrlError) throw new CustomError(error.message);
    const reason = error instanceof Error && error.name === "TimeoutError" ? "it didn't answer in 15 seconds" : "the address couldn't be reached";
    console.info(`[custom] ${request.method} ${new URL(request.url).host} failed ${Date.now() - started}ms`);
    throw new CustomError(`Couldn't reach the provider: ${reason}`);
  }
};

// The spec as saved, checked again: it may have been written by an older version.
export function loadSpec(config: Connection["config"]): CustomSpec {
  const check = checkSpec(config.custom?.spec);
  if (!check.ok) throw new Error(`This custom provider's spec has problems: ${check.problems.join("; ")}`);
  return check.spec;
}

export function customProviderFor(connection: Connection, http: CustomHttp = customHttp) {
  const { custom } = connection.config;
  if (!custom || !connection.accessTokenEnc) throw new Error("This custom provider hasn't finished connecting");
  const secrets = JSON.parse(decrypt(connection.accessTokenEnc)) as Record<string, string>;
  return new CustomProvider({ spec: loadSpec(connection.config), secrets, domains: custom.domains }, http);
}

export function providerFor(connection: Connection): MailProvider {
  switch (connection.provider) {
    case "ses":
      return sesProviderFor(connection);
    case "resend":
      return new ResendProvider(clientForConnection(connection.id));
    case "postmark":
      return postmarkProviderFor(connection);
    case "mailgun":
      return mailgunProviderFor(connection);
    case "smtp":
      return smtpProviderFor(connection);
    case "sendgrid":
      return sendgridProviderFor(connection);
    case "brevo":
      return brevoProviderFor(connection);
    case "mailersend":
      return mailersendProviderFor(connection);
    case "mailjet":
      return mailjetProviderFor(connection);
    case "bird":
      return birdProviderFor(connection);
    case "custom":
      return customProviderFor(connection);
    default: {
      // A kind cloud implements (the public demo's).
      const make = getExtensions().mail?.providers?.[connection.provider];
      if (!make) throw new Error(`No provider for ${connection.provider}`);
      return make(connection);
    }
  }
}

// Removes what HelloBox set up in the provider account: Resend's webhook, the SES
// receipt rule. Runs while the credentials still work, and failing only means the
// provider keeps calling a webhook that now answers with nothing.
export async function tearDownConnection(connection: Connection) {
  try {
    switch (connection.provider) {
      case "ses":
        if (connection.status === "active" && connection.config.receiving) {
          await sesProviderFor(connection).disableReceiving();
        }
        return;
      case "resend":
        if (connection.webhookId) await clientForConnection(connection.id).deleteWebhook(connection.webhookId);
        return;
      case "postmark":
        if (connection.status === "active") {
          await postmarkProviderFor(connection).disconnect(connection.webhookId ? Number(connection.webhookId) : null);
        }
        return;
      case "mailgun":
        if (connection.status === "active") await mailgunProviderFor(connection).disconnect(connection.webhookId);
        return;
      case "sendgrid":
        if (connection.status === "active") await sendgridProviderFor(connection).disconnect(connection.webhookId);
        return;
      case "brevo":
        if (connection.status === "active") await brevoProviderFor(connection).disconnect(connection.webhookId);
        return;
      case "bird":
        if (connection.status === "active") await birdProviderFor(connection).disconnect(connection.webhookId);
        return;
      case "mailjet":
        if (connection.status === "active") await mailjetProviderFor(connection).disconnect(connection.config.mailjet?.callbacks ?? []);
        return;
      case "mailersend":
        if (connection.status === "active") {
          const webhooks = Object.values(connection.config.mailersend?.webhooks ?? {}).map((webhook) => webhook.id);
          await mailersendProviderFor(connection).disconnect(webhooks);
        }
        return;
      // Nothing was set up at the server.
      case "smtp":
      case "custom":
      case "demo":
        return;
    }
  } catch (error) {
    console.error(`[connections] Couldn't tear down ${connection.provider} for ${connection.id}:`, error);
  }
}

export async function loadConnection(connectionId: string) {
  const [connection] = await getDb()
    .select()
    .from(connections)
    .where(eq(connections.id, connectionId));
  if (!connection) throw new Error("Connection not found");
  return connection;
}

export async function providerForConnection(connectionId: string) {
  return providerFor(await loadConnection(connectionId));
}

// A customer can delete the stack, change the role or revoke a Postmark token or a
// Mailgun key at any time. Like a revoked OAuth grant, that leaves the connection waiting to be reconnected.
// Access the customer has to give again, and whose provider it is: a deleted AWS role, a
// refused Postmark or Mailgun key, or a Resend grant that expired, was revoked or lost
// its scope. Retrying never fixes these; reconnecting does.
export function grantErrorProvider(error: unknown): ProviderKind | null {
  if (error instanceof RoleAccessError) return "ses";
  if (isPostmarkAuthError(error)) return "postmark";
  if (isMailgunAuthError(error)) return "mailgun";
  if (isSmtpAuthError(error)) return "smtp";
  if (isSendgridAuthError(error)) return "sendgrid";
  if (isBrevoAuthError(error)) return "brevo";
  if (isMailersendAuthError(error)) return "mailersend";
  if (isMailjetAuthError(error)) return "mailjet";
  if (isBirdAuthError(error)) return "bird";
  if (isCustomAuthError(error)) return "custom";
  if (error instanceof OAuthGrantError) return "resend";
  // "Access token is missing required scopes: full_access", or a token Resend no longer knows.
  if (error instanceof ResendApiError && (error.status === 401 || (error.status === 403 && /scope/i.test(error.message)))) {
    return "resend";
  }
  return null;
}

export const isGrantError = (error: unknown) => grantErrorProvider(error) !== null;

// What people see instead of the provider's raw error.
export const reconnectMessage = (provider: ProviderKind) =>
  `${PROVIDER_INFO[provider].name} access expired or was removed. Reconnect it in Settings to keep going.`;

async function markNeedsReconnect(connectionId: string) {
  await getDb()
    .update(connections)
    .set({ status: "needs_reconnect" })
    .where(and(eq(connections.id, connectionId), eq(connections.status, "active")));
}

// Turns the connection to "needs reconnecting" when the error says its access is gone, so
// the app asks for the setup again and the worker stops trying. True when it did.
export async function markIfRoleRevoked(connectionId: string, error: unknown) {
  if (!isGrantError(error)) return false;
  await markNeedsReconnect(connectionId);
  return true;
}

// For errors that don't say which connection they came from, such as an action's: the
// workspace's active connections of that provider. Resend is one OAuth grant per workspace.
export async function markProviderNeedsReconnect(workspaceId: string, provider: ProviderKind) {
  await getDb()
    .update(connections)
    .set({ status: "needs_reconnect" })
    .where(and(eq(connections.workspaceId, workspaceId), eq(connections.provider, provider), eq(connections.status, "active")));
}

// Imports domains, enabling new ones up to the plan's limit. Domains removed in HelloBox
// keep their row, so they're never new here and stay removed. A domain someone else has on
// (see domainClaims) comes in switched off, and one that has just been verified while
// someone else already has it on is switched off, so it never ends up on in two places.
export async function syncDomains(
  connectionId: string,
  workspaceId: string,
  domainLimit: number,
) {
  const remote = await (await providerForConnection(connectionId)).listDomains();
  const db = getDb();
  const counted = await countedDomainNames(workspaceId);
  const limit = domainLimit;

  const known = remote.length
    ? await db
        .select({ id: domains.id, providerDomainId: domains.providerDomainId, status: domains.status, enabled: domains.enabled })
        .from(domains)
        .where(
          and(
            eq(domains.connectionId, connectionId),
            inArray(domains.providerDomainId, remote.map((d) => d.id)),
          ),
        )
    : [];
  const knownByProviderId = new Map(known.map((row) => [row.providerDomainId, row]));

  for (const domain of remote) {
    const existing = knownByProviderId.get(domain.id);
    const justVerified = Boolean(existing?.enabled && existing.status !== "verified" && domain.status === "verified");
    await db.transaction(async (tx) => {
      let enable = false;
      if (!existing || justVerified) {
        await lockDomainName(tx, domain.name);
        const taken = claimConflict(await domainClaims(tx, domain.name), { domainId: existing?.id, workspaceId });
        // A subdomain of a domain that's on is free, so it's never imported off.
        enable = !existing && !taken && fitsPlan(counted, domain.name, limit);
        if (justVerified && taken) {
          await tx.update(domains).set({ enabled: false }).where(eq(domains.id, existing!.id));
        }
      }
      if (enable) counted.push(domain.name);
      await tx
        .insert(domains)
        .values({
          workspaceId,
          connectionId,
          providerDomainId: domain.id,
          name: domain.name,
          enabled: enable,
          status: domain.status,
          sendingEnabled: domain.sending,
          receivingEnabled: domain.receiving,
        })
        .onConflictDoUpdate({
          target: [domains.connectionId, domains.providerDomainId],
          set: {
            name: domain.name,
            status: domain.status,
            sendingEnabled: domain.sending,
            receivingEnabled: domain.receiving,
          },
        });
    });
  }
}
