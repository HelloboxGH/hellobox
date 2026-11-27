import {
  ChangeResourceRecordSetsCommand,
  ListHostedZonesByNameCommand,
  ListResourceRecordSetsCommand,
  Route53Client,
} from "@aws-sdk/client-route-53";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutBucketLifecycleConfigurationCommand,
  PutBucketPolicyCommand,
  PutPublicAccessBlockCommand,
  S3Client,
  type BucketLocationConstraint,
} from "@aws-sdk/client-s3";
import {
  CreateReceiptRuleCommand,
  CreateReceiptRuleSetCommand,
  DeleteReceiptRuleCommand,
  DescribeActiveReceiptRuleSetCommand,
  DescribeReceiptRuleCommand,
  SESClient,
  SetActiveReceiptRuleSetCommand,
  UpdateReceiptRuleCommand,
  type ReceiptRule,
} from "@aws-sdk/client-ses";
import {
  CreateConfigurationSetCommand,
  CreateConfigurationSetEventDestinationCommand,
  CreateEmailIdentityCommand,
  GetAccountCommand,
  GetEmailIdentityCommand,
  ListEmailIdentitiesCommand,
  PutAccountDetailsCommand,
  PutEmailIdentityMailFromAttributesCommand,
  SendEmailCommand,
  SESv2Client,
  UpdateConfigurationSetEventDestinationCommand,
  type EventType,
} from "@aws-sdk/client-sesv2";
import {
  CreateTopicCommand,
  SetTopicAttributesCommand,
  SNSClient,
  SubscribeCommand,
} from "@aws-sdk/client-sns";
import { readObject } from "@hellobox/storage";
import { dmarcRecord, hasDmarcPolicy, keepsExisting } from "../dns";
import { buildRawEmail, parseRawEmail } from "../mime";
import type {
  DnsRecord,
  InboundEmail,
  InboundHint,
  MailProvider,
  OutgoingMessage,
  ProviderDomain,
} from "../types";
import { credentialsFor, type RoleTarget } from "./credentials";

export const CONFIGURATION_SET = "hellobox";
export const EVENTS_TOPIC = "hellobox-events";
export const INBOUND_TOPIC = "hellobox-inbound";
export const INBOUND_PREFIX = "inbound/";
const RULE_SET = "hellobox";
const EVENT_DESTINATION = "hellobox-events";
// SES writes this object when a rule that stores to S3 is created.
export const SES_SETUP_OBJECT = "AMAZON_SES_SETUP_NOTIFICATION";

const EVENT_TYPES: EventType[] = ["DELIVERY", "BOUNCE", "COMPLAINT", "REJECT", "DELIVERY_DELAY"];

export interface ReceivingConfig {
  bucket: string;
  topicArn: string;
  ruleSetName: string;
  ruleName: string;
}

export interface SesTarget extends RoleTarget {
  region: string;
  accountId: string;
  receiving?: ReceivingConfig;
}

export interface AccountStatus {
  productionAccess: boolean;
  sendingEnabled: boolean;
  maxSendRate: number;
  max24HourSend: number;
  sentLast24Hours: number;
  // Set while AWS reviews a production access request.
  reviewStatus: string | null;
}

export interface ProductionAccessRequest {
  mailType: "MARKETING" | "TRANSACTIONAL";
  websiteUrl: string;
  contactEmails: string[];
  // How the account will use SES, in the person's words. AWS marks the field deprecated
  // but still accepts it, up to 5,000 characters.
  useCaseDescription?: string;
}

const errorName = (error: unknown) => (error as { name?: string } | null)?.name ?? "";

// SES writes its own Message-ID over the one we set, in this form.
export function sesMessageIdHeader(messageId: string, region: string) {
  const host = region === "us-east-1" ? "email.amazonses.com" : `${region}.amazonses.com`;
  return `<${messageId}@${host}>`;
}

export const inboundBucketName = (accountId: string, region: string) =>
  `hellobox-inbound-${accountId}-${region}`;

export const receiptRuleName = (connectionId: string) => `hellobox-${connectionId}`.slice(0, 64);

export const inboundMxRecord = (domain: string, region: string): DnsRecord => ({
  type: "MX",
  name: domain,
  value: `inbound-smtp.${region}.amazonaws.com`,
  priority: 10,
  purpose: "Delivers mail for this domain to Amazon SES",
  keepExisting: true,
});

// Bounces come back to this subdomain, so SPF passes for the domain itself. Resend uses
// send., so a domain can be on both.
export const mailFromDomain = (domain: string) => `bounce.${domain}`;

async function collect(stream: ReadableStream<Uint8Array>) {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function bareAddress(value: string) {
  const match = value.match(/<([^>]+)>/);
  return (match?.[1] ?? value).trim();
}

// SES tags allow only letters, numbers, - _ . and @.
const tagValue = (value: string) => value.replace(/[^A-Za-z0-9_.@-]/g, "_").slice(0, 256);

export class SesProvider implements MailProvider {
  readonly kind = "ses" as const;
  private readonly credentials;
  private clients: {
    sesv2?: SESv2Client;
    ses?: SESClient;
    s3?: S3Client;
    sns?: SNSClient;
    route53?: Route53Client;
  } = {};

  constructor(readonly target: SesTarget) {
    this.credentials = credentialsFor(target);
  }

  private get sesv2() {
    return (this.clients.sesv2 ??= new SESv2Client({ region: this.target.region, credentials: this.credentials }));
  }
  private get ses() {
    return (this.clients.ses ??= new SESClient({ region: this.target.region, credentials: this.credentials }));
  }
  private get s3() {
    return (this.clients.s3 ??= new S3Client({ region: this.target.region, credentials: this.credentials }));
  }
  private get sns() {
    return (this.clients.sns ??= new SNSClient({ region: this.target.region, credentials: this.credentials }));
  }
  private get route53() {
    return (this.clients.route53 ??= new Route53Client({ region: "us-east-1", credentials: this.credentials }));
  }

  // SES only holds mail for us once receiving is on. Domains verify in the background
  // after DNS changes.
  get capabilities() {
    return { receiving: true, backfill: Boolean(this.target.receiving), refreshDomains: true };
  }

  private receiving() {
    if (!this.target.receiving) throw new Error("Receiving isn't set up for this AWS account");
    return this.target.receiving;
  }

  // Mail

  async listDomains(): Promise<ProviderDomain[]> {
    const receiving = new Set(await this.receivingDomains());
    const domains: ProviderDomain[] = [];
    let token: string | undefined;
    do {
      const page = await this.sesv2.send(new ListEmailIdentitiesCommand({ NextToken: token, PageSize: 100 }));
      for (const identity of page.EmailIdentities ?? []) {
        if (identity.IdentityType !== "DOMAIN" || !identity.IdentityName) continue;
        const name = identity.IdentityName.toLowerCase();
        const verified = identity.VerificationStatus === "SUCCESS";
        domains.push({
          id: name,
          name,
          status: verified ? "verified" : (identity.VerificationStatus ?? "pending").toLowerCase(),
          sending: verified && identity.SendingEnabled !== false,
          receiving: receiving.has(name),
        });
      }
      token = page.NextToken;
    } while (token);
    return domains;
  }

  async send(message: OutgoingMessage) {
    const attachments = await Promise.all(
      (message.attachments ?? []).map(async (file) => ({
        filename: file.filename,
        contentType: file.contentType,
        contentId: file.contentId,
        content: await collect(await readObject(file.storageKey)),
      })),
    );
    const raw = await buildRawEmail(message, attachments);
    const { MessageId } = await this.sesv2.send(
      new SendEmailCommand({
        Destination: {
          ToAddresses: message.to.map(bareAddress),
          CcAddresses: message.cc?.map(bareAddress),
          BccAddresses: message.bcc?.map(bareAddress),
        },
        Content: { Raw: { Data: raw } },
        ConfigurationSetName: CONFIGURATION_SET,
        EmailTags: Object.entries(message.tags ?? {}).map(([Name, Value]) => ({
          Name: tagValue(Name),
          Value: tagValue(Value),
        })),
      }),
    );
    if (!MessageId) throw new Error("Amazon SES accepted the email but returned no id");
    return { id: MessageId, messageIdHeader: sesMessageIdHeader(MessageId, this.target.region) };
  }

  async fetchInbound(id: string, hint: InboundHint = {}): Promise<InboundEmail> {
    const { bucket } = this.receiving();
    const object = await this.s3.send(new GetObjectCommand({ Bucket: bucket, Key: `${INBOUND_PREFIX}${id}` }));
    if (!object.Body) throw new Error(`Inbound email ${id} is empty`);
    const raw = await object.Body.transformToByteArray();
    return parseRawEmail(id, raw, hint);
  }

  async listInbound(next?: string) {
    const { bucket } = this.receiving();
    const page = await this.s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: INBOUND_PREFIX, ContinuationToken: next, MaxKeys: 100 }),
    );
    const ids = (page.Contents ?? [])
      .map((object) => object.Key?.slice(INBOUND_PREFIX.length) ?? "")
      .filter((id) => id && id !== SES_SETUP_OBJECT);
    return { ids, next: page.IsTruncated ? page.NextContinuationToken : undefined };
  }

  // The bucket is only a waiting room. Once the email is in our storage it goes.
  async afterIngest(id: string) {
    const { bucket } = this.receiving();
    await this.s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: `${INBOUND_PREFIX}${id}` }));
  }

  // Account

  async accountStatus(): Promise<AccountStatus> {
    const account = await this.sesv2.send(new GetAccountCommand({}));
    return {
      productionAccess: account.ProductionAccessEnabled ?? false,
      sendingEnabled: account.SendingEnabled ?? false,
      maxSendRate: account.SendQuota?.MaxSendRate ?? 1,
      max24HourSend: account.SendQuota?.Max24HourSend ?? 200,
      sentLast24Hours: account.SendQuota?.SentLast24Hours ?? 0,
      reviewStatus: account.Details?.ReviewDetails?.Status ?? null,
    };
  }

  async requestProductionAccess(request: ProductionAccessRequest) {
    await this.sesv2.send(
      new PutAccountDetailsCommand({
        MailType: request.mailType,
        WebsiteURL: request.websiteUrl,
        ContactLanguage: "EN",
        AdditionalContactEmailAddresses: request.contactEmails.slice(0, 4),
        UseCaseDescription: request.useCaseDescription?.trim().slice(0, 5000) || undefined,
        ProductionAccessEnabled: true,
      }),
    );
  }

  // Delivery events go to an SNS topic that posts to our webhook. Safe to run again.
  async ensureEvents(endpoint: string) {
    try {
      await this.sesv2.send(new CreateConfigurationSetCommand({ ConfigurationSetName: CONFIGURATION_SET }));
    } catch (error) {
      if (errorName(error) !== "AlreadyExistsException") throw error;
    }
    const topicArn = await this.ensureTopic(EVENTS_TOPIC, endpoint);
    const destination = {
      Enabled: true,
      MatchingEventTypes: EVENT_TYPES,
      SnsDestination: { TopicArn: topicArn },
    };
    try {
      await this.sesv2.send(
        new CreateConfigurationSetEventDestinationCommand({
          ConfigurationSetName: CONFIGURATION_SET,
          EventDestinationName: EVENT_DESTINATION,
          EventDestination: destination,
        }),
      );
    } catch (error) {
      if (errorName(error) !== "AlreadyExistsException") throw error;
      await this.sesv2.send(
        new UpdateConfigurationSetEventDestinationCommand({
          ConfigurationSetName: CONFIGURATION_SET,
          EventDestinationName: EVENT_DESTINATION,
          EventDestination: destination,
        }),
      );
    }
    return topicArn;
  }

  // A topic only SES in this account can publish to, subscribed to our webhook.
  private async ensureTopic(name: string, endpoint: string) {
    const { TopicArn } = await this.sns.send(new CreateTopicCommand({ Name: name }));
    if (!TopicArn) throw new Error(`Couldn't create the ${name} topic`);
    await this.sns.send(
      new SetTopicAttributesCommand({
        TopicArn,
        AttributeName: "Policy",
        AttributeValue: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Sid: "AllowSesPublish",
              Effect: "Allow",
              Principal: { Service: "ses.amazonaws.com" },
              Action: "sns:Publish",
              Resource: TopicArn,
              Condition: { StringEquals: { "aws:SourceAccount": this.target.accountId } },
            },
          ],
        }),
      }),
    );
    // Subscribing again with the same endpoint returns the existing subscription.
    await this.sns.send(new SubscribeCommand({ TopicArn, Protocol: "https", Endpoint: endpoint }));
    return TopicArn;
  }

  // Domains

  async addDomain(name: string) {
    try {
      await this.sesv2.send(new CreateEmailIdentityCommand({ EmailIdentity: name }));
    } catch (error) {
      if (errorName(error) !== "AlreadyExistsException") throw error;
    }
    await this.ensureMailFrom(name);
    return this.domainRecords(name);
  }

  // Roles from before custom MAIL FROM can't set it, and keep bouncing to amazonses.com.
  private async ensureMailFrom(name: string) {
    try {
      await this.sesv2.send(
        new PutEmailIdentityMailFromAttributesCommand({
          EmailIdentity: name,
          MailFromDomain: mailFromDomain(name),
          BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
        }),
      );
      return true;
    } catch (error) {
      if (errorName(error) === "AccessDeniedException") return false;
      throw error;
    }
  }

  async domainRecords(name: string): Promise<DnsRecord[]> {
    const identity = await this.sesv2.send(new GetEmailIdentityCommand({ EmailIdentity: name }));
    const records: DnsRecord[] = (identity.DkimAttributes?.Tokens ?? []).map((token) => ({
      type: "CNAME",
      name: `${token}._domainkey.${name}`,
      value: `${token}.dkim.amazonses.com`,
      purpose: "Signs your mail with DKIM and verifies the domain",
    }));
    // Domains added before MAIL FROM was set up get it here.
    const mailFrom = identity.MailFromAttributes?.MailFromDomain
      ?? ((await this.ensureMailFrom(name)) ? mailFromDomain(name) : null);
    if (mailFrom) {
      records.push(
        {
          type: "MX",
          name: mailFrom,
          value: `feedback-smtp.${this.target.region}.amazonses.com`,
          priority: 10,
          purpose: "Receives bounces, so SPF passes for your domain",
        },
        {
          type: "TXT",
          name: mailFrom,
          value: "v=spf1 include:amazonses.com ~all",
          purpose: "Lets Amazon SES send for your domain (SPF)",
        },
      );
    }
    if (!(await hasDmarcPolicy(name))) records.push(dmarcRecord(name));
    if ((await this.receivingDomains()).includes(name)) {
      records.push(inboundMxRecord(name, this.target.region));
    }
    return records;
  }

  // Writes records into the domain's Route 53 zone. An MX that points somewhere else is
  // left alone, because replacing it would take the domain's current mail away, and so is
  // a DMARC policy the domain already has.
  async applyRoute53(domain: string, records: DnsRecord[]) {
    const zone = await this.findZone(domain);
    if (!zone) return { zone: null, applied: [] as DnsRecord[], skipped: records };
    const applied: DnsRecord[] = [];
    const skipped: DnsRecord[] = [];
    for (const record of records) {
      if (record.keepExisting) {
        const existing = await this.route53.send(
          new ListResourceRecordSetsCommand({
            HostedZoneId: zone,
            StartRecordName: record.name,
            StartRecordType: record.type,
            MaxItems: 1,
          }),
        );
        const current = existing.ResourceRecordSets?.[0];
        const sameName = current?.Name?.replace(/\.$/, "") === record.name && current?.Type === record.type;
        // TXT values come back quoted, in chunks.
        const values = (current?.ResourceRecords ?? []).map((entry) => (entry.Value ?? "").replace(/" "/g, "").replace(/^"|"$/g, ""));
        if (sameName && keepsExisting(record, values)) {
          skipped.push(record);
          continue;
        }
      }
      const value = record.type === "MX" ? `${record.priority ?? 10} ${record.value}` : record.value;
      await this.route53.send(
        new ChangeResourceRecordSetsCommand({
          HostedZoneId: zone,
          ChangeBatch: {
            Comment: "HelloBox",
            Changes: [
              {
                Action: "UPSERT",
                ResourceRecordSet: {
                  Name: record.name,
                  Type: record.type,
                  TTL: 1800,
                  ResourceRecords: [{ Value: record.type === "TXT" ? `"${value}"` : value }],
                },
              },
            ],
          },
        }),
      );
      applied.push(record);
    }
    return { zone, applied, skipped };
  }

  // While an account is in the sandbox, SES only delivers to verified identities. Adding
  // an address makes AWS email it a confirmation link.
  async addTestRecipient(email: string) {
    try {
      await this.sesv2.send(new CreateEmailIdentityCommand({ EmailIdentity: email }));
    } catch (error) {
      if (errorName(error) !== "AlreadyExistsException") throw error;
    }
  }

  async testRecipients() {
    const recipients: { email: string; verified: boolean }[] = [];
    let token: string | undefined;
    do {
      const page = await this.sesv2.send(new ListEmailIdentitiesCommand({ NextToken: token, PageSize: 100 }));
      for (const identity of page.EmailIdentities ?? []) {
        if (identity.IdentityType !== "EMAIL_ADDRESS" || !identity.IdentityName) continue;
        recipients.push({ email: identity.IdentityName.toLowerCase(), verified: identity.VerificationStatus === "SUCCESS" });
      }
      token = page.NextToken;
    } while (token);
    return recipients.sort((a, b) => a.email.localeCompare(b.email));
  }

  // Whether we can write this domain's DNS, so the UI can say so before anyone tries.
  async hasRoute53Zone(domain: string) {
    return (await this.findZone(domain)) !== null;
  }

  // The public zone with the longest name that the domain falls under.
  private async findZone(domain: string) {
    const { HostedZones } = await this.route53.send(new ListHostedZonesByNameCommand({ DNSName: domain }));
    const candidates = (HostedZones ?? [])
      .filter((zone) => !zone.Config?.PrivateZone && zone.Name && zone.Id)
      .map((zone) => ({ id: zone.Id!.replace("/hostedzone/", ""), name: zone.Name!.replace(/\.$/, "") }))
      .filter((zone) => domain === zone.name || domain.endsWith(`.${zone.name}`))
      .sort((a, b) => b.name.length - a.name.length);
    return candidates[0]?.id ?? null;
  }

  // Receiving

  private async describeRule(): Promise<ReceiptRule | null> {
    const receiving = this.target.receiving;
    if (!receiving) return null;
    try {
      const { Rule } = await this.ses.send(
        new DescribeReceiptRuleCommand({ RuleSetName: receiving.ruleSetName, RuleName: receiving.ruleName }),
      );
      return Rule ?? null;
    } catch (error) {
      if (["RuleDoesNotExistException", "RuleSetDoesNotExistException"].includes(errorName(error))) return null;
      throw error;
    }
  }

  async receivingDomains() {
    const rule = await this.describeRule();
    return (rule?.Recipients ?? []).map((recipient) => recipient.toLowerCase());
  }

  // Sets up everything SES needs to hand us mail: a private bucket that empties itself,
  // a topic that tells us when mail lands, and a receipt rule for the given domains.
  async enableReceiving(input: { connectionId: string; endpoint: string; domains: string[] }) {
    if (!input.domains.length) throw new Error("Pick at least one domain to receive mail for");
    const { accountId, region } = this.target;
    const bucket = inboundBucketName(accountId, region);
    try {
      await this.s3.send(
        new CreateBucketCommand({
          Bucket: bucket,
          ...(region === "us-east-1"
            ? {}
            : { CreateBucketConfiguration: { LocationConstraint: region as BucketLocationConstraint } }),
        }),
      );
    } catch (error) {
      if (errorName(error) !== "BucketAlreadyOwnedByYou") throw error;
    }
    await this.s3.send(
      new PutPublicAccessBlockCommand({
        Bucket: bucket,
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          IgnorePublicAcls: true,
          BlockPublicPolicy: true,
          RestrictPublicBuckets: true,
        },
      }),
    );
    await this.s3.send(
      new PutBucketPolicyCommand({
        Bucket: bucket,
        Policy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Sid: "AllowSesPuts",
              Effect: "Allow",
              Principal: { Service: "ses.amazonaws.com" },
              Action: "s3:PutObject",
              Resource: `arn:aws:s3:::${bucket}/${INBOUND_PREFIX}*`,
              Condition: { StringEquals: { "aws:SourceAccount": accountId } },
            },
          ],
        }),
      }),
    );
    // A safety net: anything we failed to collect disappears after a day.
    await this.s3.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: bucket,
        LifecycleConfiguration: {
          Rules: [
            {
              ID: "hellobox-expire-inbound",
              Status: "Enabled",
              Filter: { Prefix: INBOUND_PREFIX },
              Expiration: { Days: 1 },
            },
          ],
        },
      }),
    );
    const topicArn = await this.ensureTopic(INBOUND_TOPIC, input.endpoint);

    // Only one rule set can be active per region, and the account may already use one.
    // Ours goes into the active set, or into a new one when there is none.
    const active = await this.ses.send(new DescribeActiveReceiptRuleSetCommand({}));
    let ruleSetName = active.Metadata?.Name;
    if (!ruleSetName) {
      try {
        await this.ses.send(new CreateReceiptRuleSetCommand({ RuleSetName: RULE_SET }));
      } catch (error) {
        if (errorName(error) !== "AlreadyExistsException") throw error;
      }
      await this.ses.send(new SetActiveReceiptRuleSetCommand({ RuleSetName: RULE_SET }));
      ruleSetName = RULE_SET;
    }
    const receiving: ReceivingConfig = { bucket, topicArn, ruleSetName, ruleName: receiptRuleName(input.connectionId) };
    const rule: ReceiptRule = {
      Name: receiving.ruleName,
      Enabled: true,
      ScanEnabled: true,
      TlsPolicy: "Optional",
      Recipients: input.domains,
      Actions: [{ S3Action: { BucketName: bucket, ObjectKeyPrefix: INBOUND_PREFIX, TopicArn: topicArn } }],
    };
    const existing = active.Rules?.some((candidate) => candidate.Name === receiving.ruleName);
    await this.ses.send(
      existing
        ? new UpdateReceiptRuleCommand({ RuleSetName: ruleSetName, Rule: rule })
        : new CreateReceiptRuleCommand({ RuleSetName: ruleSetName, Rule: rule }),
    );
    this.target.receiving = receiving;
    return receiving;
  }

  // An empty recipient list would match every address, so the last domain removes the rule.
  async setReceivingDomains(domains: string[]) {
    const rule = await this.describeRule();
    const receiving = this.receiving();
    if (!rule) throw new Error("The receipt rule is missing. Turn receiving on again.");
    if (!domains.length) return this.disableReceiving();
    await this.ses.send(
      new UpdateReceiptRuleCommand({ RuleSetName: receiving.ruleSetName, Rule: { ...rule, Recipients: domains } }),
    );
  }

  async disableReceiving() {
    const receiving = this.target.receiving;
    if (!receiving) return;
    try {
      await this.ses.send(
        new DeleteReceiptRuleCommand({ RuleSetName: receiving.ruleSetName, RuleName: receiving.ruleName }),
      );
    } catch (error) {
      if (errorName(error) !== "RuleSetDoesNotExistException") throw error;
    }
  }
}
