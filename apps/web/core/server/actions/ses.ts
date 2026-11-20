import { isAwsBrokerConfigured } from "@hellobox/config";
import {
  addProviderDomain,
  addSesTestRecipient,
  sesTestRecipients,
  applyProviderDomainDns,
  disconnectCloudflare,
  providerDomainSetup,
  refreshProviderDomain,
  setupReceivingSubdomain,
  requestSesProductionAccess,
  sesAccountStatus,
  sesUseCaseDraft,
  setSesReceiving,
  startSesConnection,
} from "@hellobox/mail";
import { isSesRegion, MailgunError, PostmarkError, RoleAccessError } from "@hellobox/providers";
import { ResendApiError } from "@hellobox/resend";
import { badRequest } from "nezt";
import { z } from "zod";
import { adminAction } from "../builder";
import { emit } from "../events";

// Errors from the customer's provider account are worth showing as they are: they say
// what to fix there, such as a missing permission or a quota.
export async function fromProvider<T>(work: () => Promise<T>) {
  try {
    return await work();
  } catch (error) {
    if (error instanceof RoleAccessError) throw badRequest(error.message);
    if (error instanceof MailgunError) throw badRequest(error.message);
    if (error instanceof ResendApiError) throw badRequest(error.message);
    if (error instanceof PostmarkError) {
      throw badRequest(error.status === 401 ? "Postmark didn't accept the token. Check it's an Account API token." : error.message);
    }
    // AWS service errors carry $metadata. Plain Errors are the setup code's own messages.
    // Anything else, like a database error, stays a server error.
    const fromService = typeof error === "object" && error !== null && "$metadata" in error;
    if (fromService || (error instanceof Error && error.constructor === Error)) {
      throw badRequest((error as Error).message || (error as Error).name);
    }
    throw error;
  }
}

const connectionInput = z.object({ connectionId: z.string() });

export const startSes = adminAction("/connections/ses/start")
  .input(z.object({ region: z.string(), route53: z.boolean().default(false) }))
  .handler(async ({ input, ctx }) => {
    if (!isAwsBrokerConfigured()) throw badRequest("Amazon SES isn't available on this server yet");
    if (!isSesRegion(input.region)) throw badRequest("Pick a region that supports receiving mail");
    const started = await startSesConnection({
      workspaceId: ctx.workspace.id,
      region: input.region,
      route53: input.route53,
    });
    await emit(ctx, "connection.ses_started", started.connectionId, { region: input.region });
    return started;
  });

export const sesStatus = adminAction("/connections/ses/status")
  .input(connectionInput)
  .handler(async ({ input, ctx }) => fromProvider(() => sesAccountStatus(input.connectionId, ctx.workspace.id)));

// The prefilled "How you'll use SES" text, built from what this connection really has.
export const sesUseCase = adminAction("/connections/ses/use-case")
  .input(connectionInput.extend({ mailType: z.enum(["MARKETING", "TRANSACTIONAL"]) }))
  .handler(async ({ input, ctx }) => ({
    text: await fromProvider(() => sesUseCaseDraft(input.connectionId, ctx.workspace.id, input.mailType)),
  }));

export const sesProductionAccess = adminAction("/connections/ses/production-access")
  .input(
    connectionInput.extend({
      mailType: z.enum(["MARKETING", "TRANSACTIONAL"]),
      websiteUrl: z.url().max(1000),
      contactEmails: z.array(z.email()).min(1).max(4),
      useCaseDescription: z.string().trim().max(5000).optional(),
    }),
  )
  .handler(async ({ input, ctx }) => {
    await fromProvider(() =>
      requestSesProductionAccess(input.connectionId, ctx.workspace.id, {
        mailType: input.mailType,
        websiteUrl: input.websiteUrl,
        contactEmails: input.contactEmails,
        useCaseDescription: input.useCaseDescription,
      }),
    );
    await emit(ctx, "connection.ses_production_requested", input.connectionId);
    return { ok: true };
  });

export const sesListTestRecipients = adminAction("/connections/ses/test-recipients")
  .input(connectionInput)
  .handler(async ({ input, ctx }) => ({
    recipients: await fromProvider(() => sesTestRecipients(input.connectionId, ctx.workspace.id)),
  }));

export const sesAddTestRecipient = adminAction("/connections/ses/test-recipients/add")
  .input(connectionInput.extend({ email: z.email() }))
  .handler(async ({ input, ctx }) => {
    await fromProvider(() => addSesTestRecipient(input.connectionId, ctx.workspace.id, input.email));
    await emit(ctx, "connection.ses_test_recipient_added", input.connectionId, { email: input.email });
    return { ok: true };
  });

// Domain records work the same for every provider HelloBox adds domains to.
export const addDomain = adminAction("/connections/domains/add")
  .input(connectionInput.extend({ domain: z.string().min(3).max(253) }))
  .handler(async ({ input, ctx }) => {
    const setup = await fromProvider(() => addProviderDomain(input.connectionId, ctx.workspace.id, input.domain));
    await emit(ctx, "domain.added", input.domain, { connectionId: input.connectionId });
    return setup;
  });

export const domainRecords = adminAction("/connections/domains/records")
  .input(connectionInput.extend({ domain: z.string() }))
  .handler(async ({ input, ctx }) => fromProvider(() => providerDomainSetup(input.connectionId, ctx.workspace.id, input.domain)));

export const applyDomainDns = adminAction("/connections/domains/apply-dns")
  .input(connectionInput.extend({ domain: z.string(), host: z.enum(["route53", "cloudflare"]) }))
  .handler(async ({ input, ctx }) =>
    fromProvider(() => applyProviderDomainDns(input.connectionId, ctx.workspace.id, input.domain, input.host)),
  );

// "Check again" on a domain waiting for DNS.
export const refreshDomain = adminAction("/connections/domains/refresh")
  .input(connectionInput.extend({ domain: z.string() }))
  .handler(async ({ input, ctx }) => fromProvider(() => refreshProviderDomain(input.connectionId, ctx.workspace.id, input.domain)));

export const receiveOnSubdomain = adminAction("/connections/domains/receive-subdomain")
  .input(connectionInput.extend({ parent: z.string(), subdomain: z.string().min(3).max(253) }))
  .handler(async ({ input, ctx }) => {
    const result = await fromProvider(() =>
      setupReceivingSubdomain(input.connectionId, ctx.workspace.id, input.parent, input.subdomain),
    );
    await emit(ctx, "domain.receiving_subdomain", input.subdomain, { connectionId: input.connectionId, parent: input.parent });
    return result;
  });

export const sesReceiving = adminAction("/connections/ses/receiving")
  .input(connectionInput.extend({ domains: z.array(z.string()).max(100) }))
  .handler(async ({ input, ctx }) => {
    const result = await fromProvider(() => setSesReceiving(input.connectionId, ctx.workspace.id, input.domains));
    await emit(ctx, "connection.ses_receiving", input.connectionId, { domains: input.domains });
    return result;
  });

// Records already written stay in the zone; this only drops our access.
export const cloudflareDisconnect = adminAction("/connections/cloudflare/disconnect")
  .input(z.object({}))
  .handler(async ({ ctx }) => {
    await disconnectCloudflare(ctx.workspace.id);
    await emit(ctx, "connection.cloudflare_disconnected");
    return { ok: true };
  });

export const sesActions = {
  "/connections/ses/start": startSes,
  "/connections/ses/status": sesStatus,
  "/connections/ses/production-access": sesProductionAccess,
  "/connections/ses/use-case": sesUseCase,
  "/connections/ses/test-recipients": sesListTestRecipients,
  "/connections/ses/test-recipients/add": sesAddTestRecipient,
  "/connections/domains/add": addDomain,
  "/connections/domains/records": domainRecords,
  "/connections/domains/apply-dns": applyDomainDns,
  "/connections/domains/refresh": refreshDomain,
  "/connections/domains/receive-subdomain": receiveOnSubdomain,
  "/connections/ses/receiving": sesReceiving,
  "/connections/cloudflare/disconnect": cloudflareDisconnect,
};
