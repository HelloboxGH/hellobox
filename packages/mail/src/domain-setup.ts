import { domains, getDb } from "@hellobox/db";
import { PROVIDER_INFO } from "@hellobox/providers";
import { and, eq, isNull } from "drizzle-orm";
import { loadConnection, syncDomains } from "./connections";
import { subdomainProblem } from "./domain-names";
import { addMailgunDomain, applyMailgunDomainDns, mailgunDomainSetup, setMailgunReceiving } from "./mailgun";
import {
  activatePendingPostmarkInbound,
  addPostmarkDomain,
  applyPostmarkDomainDns,
  postmarkDomainSetup,
  setPostmarkReceiving,
} from "./postmark";
import { addSmtpDomain, smtpDomainSetup } from "./smtp";
import { addBrevoDomain, applyBrevoDomainDns, brevoDomainSetup, setBrevoReceiving } from "./brevo";
import { addSendgridDomain, applySendgridDomainDns, sendgridDomainSetup, setSendgridReceiving } from "./sendgrid";
import { addResendReceivingDomain, applyResendDomainDns, resendDomainSetup, verifyResendDomain } from "./resend-domains";
import {
  addSesDomain,
  applySesDomainDns,
  domainLimitFor,
  sesDomainSetup,
  setSesReceiving,
  type DnsHost,
  type DomainSetup,
} from "./ses";

// Domain records for every provider, so settings has one DNS dialog for all of them.
async function kindOf(connectionId: string, workspaceId: string) {
  const connection = await loadConnection(connectionId).catch(() => null);
  if (!connection || connection.workspaceId !== workspaceId) throw new Error("Connection not found");
  return connection.provider;
}

export async function addProviderDomain(connectionId: string, workspaceId: string, domain: string) {
  const kind = await kindOf(connectionId, workspaceId);
  if (kind === "ses") return addSesDomain(connectionId, workspaceId, domain);
  if (kind === "postmark") return addPostmarkDomain(connectionId, workspaceId, domain);
  if (kind === "mailgun") return addMailgunDomain(connectionId, workspaceId, domain);
  if (kind === "smtp") return addSmtpDomain(connectionId, workspaceId, domain);
  if (kind === "sendgrid") return addSendgridDomain(connectionId, workspaceId, domain);
  if (kind === "brevo") return addBrevoDomain(connectionId, workspaceId, domain);
  return addResendReceivingDomain(connectionId, workspaceId, domain);
}

export async function providerDomainSetup(connectionId: string, workspaceId: string, domain: string) {
  const kind = await kindOf(connectionId, workspaceId);
  if (kind === "ses") return sesDomainSetup(connectionId, workspaceId, domain);
  if (kind === "postmark") return postmarkDomainSetup(connectionId, workspaceId, domain);
  if (kind === "mailgun") return mailgunDomainSetup(connectionId, workspaceId, domain);
  if (kind === "smtp") return smtpDomainSetup(connectionId, workspaceId, domain);
  if (kind === "sendgrid") return sendgridDomainSetup(connectionId, workspaceId, domain);
  if (kind === "brevo") return brevoDomainSetup(connectionId, workspaceId, domain);
  return resendDomainSetup(connectionId, workspaceId, domain);
}

export async function applyProviderDomainDns(connectionId: string, workspaceId: string, domain: string, host: DnsHost) {
  const kind = await kindOf(connectionId, workspaceId);
  if (kind === "ses") return applySesDomainDns(connectionId, workspaceId, domain, host);
  if (kind === "postmark") return applyPostmarkDomainDns(connectionId, workspaceId, domain, host);
  if (kind === "mailgun") return applyMailgunDomainDns(connectionId, workspaceId, domain, host);
  // Nothing to write: an SMTP server's records are set up wherever the server says.
  if (kind === "smtp") return smtpDomainSetup(connectionId, workspaceId, domain);
  if (kind === "sendgrid") return applySendgridDomainDns(connectionId, workspaceId, domain, host);
  if (kind === "brevo") return applyBrevoDomainDns(connectionId, workspaceId, domain, host);
  return applyResendDomainDns(connectionId, workspaceId, domain, host);
}

// "Check again": asks the provider to look at the DNS now where it can, then brings the
// domain's status up to date. SES checks by itself and has nothing to ask.
export async function refreshProviderDomain(connectionId: string, workspaceId: string, domain: string) {
  const kind = await kindOf(connectionId, workspaceId);
  // Reading the records asks Postmark and Mailgun to verify again.
  if (kind === "postmark") {
    await postmarkDomainSetup(connectionId, workspaceId, domain);
    await activatePendingPostmarkInbound(connectionId);
  }
  if (kind === "mailgun") await mailgunDomainSetup(connectionId, workspaceId, domain);
  // Reading the records asks SendGrid to validate again.
  if (kind === "sendgrid") await sendgridDomainSetup(connectionId, workspaceId, domain);
  // And Brevo to authenticate.
  if (kind === "brevo") await brevoDomainSetup(connectionId, workspaceId, domain);
  if (kind === "resend") await verifyResendDomain(connectionId, workspaceId, domain);
  await syncDomains(connectionId, workspaceId, await domainLimitFor(workspaceId));
  const [row] = await getDb()
    .select({ status: domains.status, receivingEnabled: domains.receivingEnabled })
    .from(domains)
    .where(and(eq(domains.connectionId, connectionId), eq(domains.name, domain)));
  return { status: row?.status ?? null, receivingEnabled: row?.receivingEnabled ?? false };
}

// One list of records from two setups, such as a domain's own records and its MX.
function combine(first: DomainSetup, second: DomainSetup | null | undefined): DomainSetup {
  if (!second) return first;
  const unique = <T extends { type: string; name: string; value: string }>(list: T[]) =>
    [...new Map(list.map((record) => [`${record.type}:${record.name}:${record.value}`, record])).values()];
  return {
    records: unique([...first.records, ...second.records]),
    applied: unique([...first.applied, ...second.applied]),
    skipped: unique([...first.skipped, ...second.skipped]),
    appliedTo: first.appliedTo ?? second.appliedTo,
    zoneFound: first.zoneFound ?? second.zoneFound,
    cloudflare: second.cloudflare,
  };
}

// Receiving on a subdomain, such as reply.acme.com, so replies reach HelloBox while the
// parent's own MX (often Google Workspace) stays as it is. The subdomain becomes a domain
// of its own at the provider, so replies can be sent from it, and every record written
// is named under the subdomain.
export async function setupReceivingSubdomain(connectionId: string, workspaceId: string, parent: string, name: string) {
  const subdomain = name.trim().toLowerCase().replace(/\.$/, "");
  const problem = subdomainProblem(parent, subdomain);
  if (problem) throw new Error(problem);
  const connection = await loadConnection(connectionId).catch(() => null);
  if (!connection || connection.workspaceId !== workspaceId) throw new Error("Connection not found");
  const db = getDb();
  const connected = await db
    .select({ name: domains.name, receivingEnabled: domains.receivingEnabled })
    .from(domains)
    .where(and(eq(domains.connectionId, connectionId), isNull(domains.removedAt)));
  if (!connected.some((domain) => domain.name === parent)) throw new Error(`${parent} isn't part of this connection`);

  if (!PROVIDER_INFO[connection.provider].receives) {
    throw new Error(`${PROVIDER_INFO[connection.provider].name} doesn't receive mail. Add ${subdomain} as a domain and turn on Receive with HelloBox.`);
  }
  if (connection.provider === "ses") {
    const added = await addSesDomain(connectionId, workspaceId, subdomain);
    const receiving = connected.filter((domain) => domain.receivingEnabled).map((domain) => domain.name);
    const { mx } = await setSesReceiving(connectionId, workspaceId, [...new Set([...receiving, subdomain])]);
    return { setup: combine(added, mx.find((setup) => setup.records.some((record) => record.name === subdomain))), waiting: false };
  }
  if (connection.provider === "postmark") {
    // Checked before anything is added, so a refusal leaves nothing behind.
    const postmark = connection.config.postmark;
    const current = postmark?.inboundDomain ?? postmark?.pendingInboundDomain;
    if (current && current !== subdomain) {
      throw new Error(`A Postmark server receives mail for one domain, and this one receives for ${current}. Turn that off first, or connect another Postmark server.`);
    }
    const added = await addPostmarkDomain(connectionId, workspaceId, subdomain);
    const result = await setPostmarkReceiving(connectionId, workspaceId, subdomain);
    return { setup: combine(added, result.mx), waiting: result.waiting };
  }
  if (connection.provider === "mailgun") {
    const added = await addMailgunDomain(connectionId, workspaceId, subdomain);
    const result = await setMailgunReceiving(connectionId, workspaceId, subdomain, true);
    return { setup: combine(added, result.mx), waiting: false };
  }
  if (connection.provider === "sendgrid") {
    const added = await addSendgridDomain(connectionId, workspaceId, subdomain);
    const result = await setSendgridReceiving(connectionId, workspaceId, subdomain, true);
    return { setup: combine(added, result.mx), waiting: false };
  }
  if (connection.provider === "brevo") {
    const added = await addBrevoDomain(connectionId, workspaceId, subdomain);
    const result = await setBrevoReceiving(connectionId, workspaceId, subdomain, true);
    return { setup: combine(added, result.mx), waiting: false };
  }
  return { setup: await addResendReceivingDomain(connectionId, workspaceId, subdomain), waiting: false };
}
