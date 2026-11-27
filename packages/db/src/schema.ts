import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const tsvector = customType<{ data: string }>({
  dataType: () => "tsvector",
});

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());
const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const time = (name: string) => timestamp(name, { withTimezone: true });

// Auth tables, shaped by better-auth.

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  twoFactorEnabled: boolean("two_factor_enabled").default(false),
  onboardedAt: time("onboarded_at"),
  // Set by a platform admin. A banned user can't sign in or use the app.
  bannedAt: time("banned_at"),
  banReason: text("ban_reason"),
  // Unread counts beside each workspace in the switcher.
  showWorkspaceUnread: boolean("show_workspace_unread").notNull().default(true),
  // A visitor trying the demo, signed in with no email or password. Deleted with the demo.
  isAnonymous: boolean("is_anonymous").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: time("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: time("access_token_expires_at"),
    refreshTokenExpiresAt: time("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("account_user_idx").on(t.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: time("expires_at").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

export const twoFactor = pgTable(
  "two_factor",
  {
    id: text("id").primaryKey(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    verified: boolean("verified").default(true),
    failedVerificationCount: integer("failed_verification_count").default(0),
    lockedUntil: time("locked_until"),
  },
  (t) => [index("two_factor_user_idx").on(t.userId)],
);

// Workspaces.

export const roleEnum = pgEnum("role", ["owner", "admin", "member"]);

export const workspaces = pgTable("workspaces", {
  id: id(),
  name: text("name").notNull(),
  // Our own URL, /api/logos/{workspaceId}/{file}. Shown in the switcher and onboarding.
  logo: text("logo"),
  storageBytesUsed: bigint("storage_bytes_used", { mode: "number" })
    .notNull()
    .default(0),
  // Set by a platform admin. Nobody can open or send from a suspended workspace.
  suspendedAt: time("suspended_at"),
  suspendReason: text("suspend_reason"),
  // Set on a demo sandbox. Maintenance deletes it once this has passed.
  demoExpiresAt: time("demo_expires_at"),
  // Answer mail to an address with no mailbox with a bounce. Off by default: bounces cost
  // sending credits and can be provoked by anyone, so a workspace opts in.
  bouncesEnabled: boolean("bounces_enabled").notNull().default(false),
  // The last time anyone used the workspace: a member signing in or using the app, an API
  // or agent call, or mail sent from it. Mail arriving doesn't count, since it keeps coming
  // to abandoned domains. Updated at most hourly. A domain can only be claimed away from a
  // workspace that has been quiet for a while (see domainTakeovers).
  lastActiveAt: time("last_active_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const members = pgTable(
  "members",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: roleEnum("role").notNull().default("member"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("members_workspace_user_idx").on(t.workspaceId, t.userId),
    index("members_user_idx").on(t.userId),
  ],
);

export const invitations = pgTable(
  "invitations",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: roleEnum("role").notNull().default("member"),
    tokenHash: text("token_hash").notNull().unique(),
    invitedBy: text("invited_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    expiresAt: time("expires_at").notNull(),
    acceptedAt: time("accepted_at"),
    createdAt: createdAt(),
  },
  (t) => [index("invitations_workspace_idx").on(t.workspaceId)],
);

// A workspace's link to an email provider. The row's id doubles as the unguessable
// webhook path. Resend connects through OAuth and keeps tokens here. SES connects
// through a role in the customer's AWS account, described in config.

export const connectionStatusEnum = pgEnum("connection_status", [
  "pending",
  "active",
  "needs_reconnect",
  "disconnected",
]);

// "demo" is the public sandbox's own provider: see packages/mail/src/demo.
export const providerKindEnum = pgEnum("provider_kind", [
  "resend",
  "ses",
  "postmark",
  "mailgun",
  "demo",
  "smtp",
  "sendgrid",
  "brevo",
  "mailersend",
  "mailjet",
  "bird",
  "custom",
]);

export interface ConnectionConfig {
  // SES: where the customer's stack lives and the role we assume there.
  region?: string;
  accountId?: string;
  roleArn?: string;
  // SES: lets us write DNS records when the domain's zone is in Route 53.
  route53?: boolean;
  eventsTopicArn?: string;
  receiving?: {
    bucket: string;
    topicArn: string;
    ruleSetName: string;
    ruleName: string;
  };
  // Postmark: the server HelloBox sends and receives through. A server has one inbound
  // domain, so a connection receives for at most one domain.
  postmark?: {
    serverId: number;
    serverName: string;
    inboundDomain?: string;
    // Receiving was turned on for this domain, but Postmark won't take it until it sees the
    // MX record. Retried until it does.
    pendingInboundDomain?: string;
  };
  // Mailgun: regions are isolated, and routes are account-wide, so each receiving domain
  // keeps the id of the route we made for it.
  mailgun?: {
    region: "us" | "eu";
    routes: Record<string, string>;
  };
  // SendGrid: the host its key works on, and the domains with an Inbound Parse setting of
  // ours. The API key is in accessTokenEnc, the events webhook's public key in
  // webhookSecretEnc, and the token in our Inbound Parse address in secondaryTokenEnc.
  sendgrid?: {
    region: "global" | "eu";
    receiving: string[];
    // False when SendGrid wouldn't take another events webhook (its plans cap them).
    events: boolean;
  };
  // SMTP: the server and who signs in. The password is in accessTokenEnc. The server can't
  // list domains, so these are the ones the customer added.
  smtp?: {
    host: string;
    port: 465 | 587 | 2525 | 25;
    username: string;
    domains: string[];
  };
}

export const connections = pgTable(
  "connections",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    provider: providerKindEnum("provider").notNull().default("resend"),
    config: jsonb("config").$type<ConnectionConfig>().notNull().default({}),
    // Resend: the OAuth access token. Postmark: the account token. Mailgun: the API key.
    accessTokenEnc: text("access_token_enc"),
    refreshTokenEnc: text("refresh_token_enc"),
    // Postmark: the server token, which sends and reads mail for one server.
    secondaryTokenEnc: text("secondary_token_enc"),
    accessExpiresAt: time("access_expires_at"),
    scope: text("scope"),
    webhookId: text("webhook_id"),
    // The webhook's credential: Resend's signing secret, the basic-auth password we made
    // for Postmark, or Mailgun's signing key.
    webhookSecretEnc: text("webhook_secret_enc"),
    // SES: the role's trust policy requires this, so nobody else can make us assume it.
    externalId: text("external_id"),
    // SES: the stack proves it belongs to this connection with this token. Only its
    // hash is kept, and it's cleared once the stack has reported in.
    connectTokenHash: text("connect_token_hash"),
    status: connectionStatusEnum("status").notNull().default("active"),
    lastBackfillAt: time("last_backfill_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("connections_workspace_idx").on(t.workspaceId)],
);

// A workspace's grant to edit DNS at its DNS host, so domain records can be added for it.
export const dnsConnections = pgTable(
  "dns_connections",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    provider: text("provider").$type<"cloudflare">().notNull(),
    accessTokenEnc: text("access_token_enc").notNull(),
    refreshTokenEnc: text("refresh_token_enc"),
    accessExpiresAt: time("access_expires_at"),
    scope: text("scope"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("dns_connections_workspace_provider_idx").on(t.workspaceId, t.provider)],
);

export const domains = pgTable(
  "domains",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    providerDomainId: text("provider_domain_id").notNull(),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    status: text("status"),
    sendingEnabled: boolean("sending_enabled").notNull().default(false),
    receivingEnabled: boolean("receiving_enabled").notNull().default(false),
    // Mail for the domain comes to HelloBox's own mail server (apps/mx) instead of the
    // provider's. Turned on only once the TXT record with receiveToken proves DNS control;
    // sending stays on the provider either way.
    receiveWithHellobox: boolean("receive_with_hellobox").notNull().default(false),
    receiveToken: text("receive_token"),
    // The MX records HelloBox replaced on Cloudflare, so they can be put back.
    replacedMx: jsonb("replaced_mx").$type<{ value: string; priority: number }[]>(),
    // Removed in HelloBox. The row stays so its mailboxes and mail do, and so syncing
    // doesn't bring it back. Adding the domain again or restoring it clears this.
    removedAt: time("removed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("domains_connection_provider_idx").on(
      t.connectionId,
      t.providerDomainId,
    ),
    index("domains_workspace_idx").on(t.workspaceId),
  ],
);

// Someone claiming a domain that another workspace has on (see domainClaims). They prove
// they control its DNS with a TXT record we check ourselves, their provider has to have
// verified it too, and the holder must have been quiet for 90 days. The holder's admins
// then get 7 days' notice: any activity there, or an admin keeping the domain, stops it.
export const domainTakeovers = pgTable(
  "domain_takeovers",
  {
    id: id(),
    // Lowercased, with no trailing dot (see domainKey).
    domainName: text("domain_name").notNull(),
    requesterWorkspaceId: text("requester_workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    requesterDomainId: text("requester_domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    requestedBy: text("requested_by").references(() => user.id, { onDelete: "set null" }),
    // Filled in once the TXT record checks out and the notice starts.
    holderWorkspaceId: text("holder_workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    holderDomainId: text("holder_domain_id").references(() => domains.id, { onDelete: "cascade" }),
    // The TXT record's value: hellobox-verify=<token> at _hellobox.<domain>.
    token: text("token").notNull(),
    // dns: waiting for the TXT record. notice: the holder has been told.
    status: text("status").$type<"dns" | "notice" | "completed" | "cancelled">().notNull().default("dns"),
    dnsVerifiedAt: time("dns_verified_at"),
    noticeEndsAt: time("notice_ends_at"),
    completedAt: time("completed_at"),
    cancelledAt: time("cancelled_at"),
    cancelReason: text("cancel_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("domain_takeovers_domain_idx").on(t.domainName),
    index("domain_takeovers_holder_idx").on(t.holderWorkspaceId),
    // One open claim per domain from each workspace.
    uniqueIndex("domain_takeovers_open_idx")
      .on(t.requesterWorkspaceId, t.domainName)
      .where(sql`${t.status} in ('dns', 'notice')`),
  ],
);

// "Request access" on a domain another workspace has on: its admins get an email naming
// who asked. Kept to rate-limit it.
export const domainAccessRequests = pgTable(
  "domain_access_requests",
  {
    id: id(),
    domainName: text("domain_name").notNull(),
    requesterWorkspaceId: text("requester_workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    requestedBy: text("requested_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("domain_access_requests_idx").on(t.domainName, t.requesterWorkspaceId)],
);

export const mailboxes = pgTable(
  "mailboxes",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // Unset for a mailbox made by an import before its domain was in HelloBox. It holds the
    // imported mail and can't send or receive; adding the address on a domain later gives it
    // the domain, so the history and new mail end up together.
    domainId: text("domain_id").references(() => domains.id, { onDelete: "cascade" }),
    address: text("address").notNull(),
    displayName: text("display_name"),
    isCatchAll: boolean("is_catch_all").notNull().default(false),
    // Set for a personal mailbox: only this person reads it, and admins can't assign it.
    // Unset means shared, readable by whoever it's assigned to.
    personalUserId: text("personal_user_id").references(() => user.id, { onDelete: "set null" }),
    // Mail is sealed to the owner's vault key as it arrives, so the server stores only
    // ciphertext for the body. Personal mailboxes only, for now.
    encrypted: boolean("encrypted").notNull().default(false),
    // Deleted by an admin. The row stays so its conversations do. New mail to the address
    // is treated as mail to an address with no mailbox. Adding the address again clears it.
    removedAt: time("removed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("mailboxes_workspace_address_idx").on(
      t.workspaceId,
      t.address,
    ),
  ],
);

// A person's encryption keys. The private key is wrapped with their passphrase and with a
// recovery code, both turned into keys on their device, so the server can't unwrap it.
export const vaults = pgTable("vaults", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  keyId: text("key_id").notNull(),
  publicKey: text("public_key").notNull(),
  wrappedKey: jsonb("wrapped_key").$type<WrappedKey>().notNull(),
  recoveryWrappedKey: jsonb("recovery_wrapped_key").$type<WrappedKey>().notNull(),
  createdAt: createdAt(),
  updatedAt: time("updated_at").notNull().defaultNow(),
});

type WrappedKey = {
  kdf: { name: "argon2id"; m: number; t: number; p: number; salt: string };
  iv: string;
  data: string;
};

// Mail brought in from another service as an MBOX or EML file. The file is uploaded
// straight to storage, the worker reads it one email at a time, and it's deleted after.
export const importStatusEnum = pgEnum("import_status", [
  "uploading",
  "queued",
  "running",
  "done",
  "failed",
  "cancelled",
]);

export const imports = pgTable(
  "imports",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    format: text("format").$type<"mbox" | "eml">().notNull(),
    storageKey: text("storage_key").notNull(),
    multipartUploadId: text("multipart_upload_id"),
    size: bigint("size", { mode: "number" }).notNull().default(0),
    status: importStatusEnum("status").notNull().default("uploading"),
    // Bytes of the file read so far, for progress, and what became of each email.
    bytesRead: bigint("bytes_read", { mode: "number" }).notNull().default(0),
    imported: integer("imported").notNull().default(0),
    skipped: integer("skipped").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    error: text("error"),
    createdAt: createdAt(),
    startedAt: time("started_at"),
    finishedAt: time("finished_at"),
  },
  (t) => [index("imports_workspace_idx").on(t.workspaceId, t.createdAt)],
);

export const mailboxMembers = pgTable(
  "mailbox_members",
  {
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.mailboxId, t.userId] })],
);

// Mail.

export const folderEnum = pgEnum("folder", [
  "inbox",
  "archive",
  "spam",
  "trash",
]);
export const categoryEnum = pgEnum("category", [
  "primary",
  "notifications",
  "purchases",
  "newsletters",
]);
export const directionEnum = pgEnum("direction", ["inbound", "outbound"]);

export type Address = { address: string; name?: string };

export const threads = pgTable(
  "threads",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    subject: text("subject").notNull().default(""),
    normalizedSubject: text("normalized_subject").notNull().default(""),
    snippet: text("snippet").notNull().default(""),
    participants: jsonb("participants").$type<Address[]>().notNull().default([]),
    folder: folderEnum("folder").notNull().default("inbox"),
    category: categoryEnum("category").notNull().default("primary"),
    important: boolean("important").notNull().default(false),
    hasAttachments: boolean("has_attachments").notNull().default(false),
    messageCount: integer("message_count").notNull().default(0),
    assignedTo: text("assigned_to").references(() => user.id, {
      onDelete: "set null",
    }),
    lastMessageAt: time("last_message_at").notNull().defaultNow(),
    trashedAt: time("trashed_at"),
    // Quarantined mail (to an address with no mailbox, or part of a flood) is deleted at
    // this time unless someone moves it out of Spam. Its storage isn't counted meanwhile.
    expiresAt: time("expires_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("threads_list_idx").on(
      t.workspaceId,
      t.mailboxId,
      t.folder,
      t.lastMessageAt,
    ),
    index("threads_subject_lookup_idx").on(t.mailboxId, t.normalizedSubject),
    index("threads_expires_idx").on(t.expiresAt).where(sql`${t.expiresAt} is not null`),
    index("threads_subject_trgm_idx").using(
      "gin",
      sql`${t.subject} gin_trgm_ops`,
    ),
  ],
);

// Delivery by recipient address. "*" holds events that didn't name a recipient.
export type DeliveryRecipients = Record<string, { status: string; reason?: string; at: string }>;

export const messages = pgTable(
  "messages",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    connectionId: text("connection_id").references(() => connections.id, {
      onDelete: "set null",
    }),
    direction: directionEnum("direction").notNull(),
    providerMessageId: text("provider_message_id"),
    messageIdHeader: text("message_id_header"),
    inReplyTo: text("in_reply_to"),
    references: jsonb("references").$type<string[]>().notNull().default([]),
    fromAddress: text("from_address").notNull(),
    fromName: text("from_name"),
    toRecipients: jsonb("to_recipients").$type<Address[]>().notNull().default([]),
    ccRecipients: jsonb("cc_recipients").$type<Address[]>().notNull().default([]),
    bccRecipients: jsonb("bcc_recipients")
      .$type<Address[]>()
      .notNull()
      .default([]),
    replyTo: jsonb("reply_to").$type<string[]>().notNull().default([]),
    subject: text("subject").notNull().default(""),
    snippet: text("snippet").notNull().default(""),
    textBody: text("text_body"),
    htmlBody: text("html_body"),
    // For an encrypted mailbox: the text and HTML bodies sealed to the readers' vault keys
    // (see packages/mail/src/vault.ts). textBody, htmlBody and snippet are empty then.
    sealedBody: text("sealed_body"),
    rawKey: text("raw_key"),
    // Bytes of the stored original, so freeing it gives the space back to the workspace.
    rawSize: bigint("raw_size", { mode: "number" }).notNull().default(0),
    // Whether this message's files count toward the workspace's storage. Quarantined mail
    // doesn't, so a flood can't fill a workspace; keeping it counts it from then on.
    storageCounted: boolean("storage_counted").notNull().default(true),
    spamScore: real("spam_score"),
    spamSymbols: jsonb("spam_symbols").$type<string[]>(),
    spamReasons: jsonb("spam_reasons").$type<string[]>(),
    unscanned: boolean("unscanned").notNull().default(false),
    authentication: jsonb("authentication").$type<{
      spf?: string;
      dkim?: string;
      dmarc?: string;
    } | null>(),
    // The worst status across recipients, for lists. The per-recipient detail, with the
    // provider's reason for a bounce or complaint, is in deliveryRecipients.
    deliveryStatus: text("delivery_status"),
    deliveryRecipients: jsonb("delivery_recipients").$type<DeliveryRecipients>().notNull().default({}),
    // Set when an agent sent it on someone's behalf.
    agentTokenId: text("agent_token_id").references(() => agentTokens.id, {
      onDelete: "set null",
    }),
    // The teammate who sent it from HelloBox. A shared address looks the same whoever
    // answers, so this is how the team sees who replied. Null for inbound mail.
    sentByUserId: text("sent_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    sentAt: time("sent_at").notNull().defaultNow(),
    createdAt: createdAt(),
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce(subject, '') || ' ' || coalesce(from_address, '') || ' ' || coalesce(from_name, '') || ' ' || coalesce(left(text_body, 200000), ''))`,
    ),
  },
  (t) => [
    uniqueIndex("messages_connection_email_idx").on(
      t.connectionId,
      t.providerMessageId,
    ),
    index("messages_thread_idx").on(t.threadId, t.sentAt),
    index("messages_header_idx").on(t.workspaceId, t.messageIdHeader),
    index("messages_search_idx").using("gin", t.searchVector),
    index("messages_from_trgm_idx").using(
      "gin",
      sql`${t.fromAddress} gin_trgm_ops`,
    ),
  ],
);

export const attachments = pgTable(
  "attachments",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    providerAttachmentId: text("provider_attachment_id"),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    size: bigint("size", { mode: "number" }).notNull().default(0),
    contentId: text("content_id"),
    disposition: text("disposition"),
    storageKey: text("storage_key").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("attachments_message_idx").on(t.messageId)],
);

export const threadUserState = pgTable(
  "thread_user_state",
  {
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    readAt: time("read_at"),
    starred: boolean("starred").notNull().default(false),
    snoozedUntil: time("snoozed_until"),
  },
  (t) => [
    primaryKey({ columns: [t.threadId, t.userId] }),
    index("thread_state_user_idx").on(t.userId, t.starred),
  ],
);

export const labels = pgTable(
  "labels",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color"),
    // A Phosphor icon name from the app's own set (components/mail/label-style.tsx).
    icon: text("icon"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("labels_workspace_name_idx").on(t.workspaceId, t.name)],
);

export const threadLabels = pgTable(
  "thread_labels",
  {
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    labelId: text("label_id")
      .notNull()
      .references(() => labels.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.threadId, t.labelId] })],
);

export type RuleCondition = {
  field: "from" | "fromDomain" | "to" | "subject";
  op: "equals" | "contains";
  value: string;
};
export type RuleAction = {
  category?: "primary" | "notifications" | "purchases" | "newsletters";
  labelId?: string;
  folder?: "inbox" | "archive" | "spam" | "trash";
};

export const rules = pgTable(
  "rules",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    priority: integer("priority").notNull().default(100),
    conditions: jsonb("conditions").$type<RuleCondition[]>().notNull(),
    action: jsonb("action").$type<RuleAction>().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("rules_workspace_idx").on(t.workspaceId, t.priority)],
);

export const senderListKindEnum = pgEnum("sender_list_kind", [
  "blocked",
  "allowed",
  "images_allowed",
]);

export const suppressionReasonEnum = pgEnum("suppression_reason", ["bounce", "complaint"]);

// Addresses this workspace doesn't send to, because they bounced permanently or the person
// marked our mail as spam. Every row says why and where it came from, and admins can
// remove one in settings.
export const suppressions = pgTable(
  "suppressions",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    reason: suppressionReasonEnum("reason").notNull(),
    // What the receiving server or provider said, when there's anything.
    detail: text("detail"),
    connectionId: text("connection_id").references(() => connections.id, { onDelete: "set null" }),
    // The sent email that bounced or was reported: an inbox message, or a campaign send.
    messageId: text("message_id").references(() => messages.id, { onDelete: "set null" }),
    campaignId: text("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    providerMessageId: text("provider_message_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("suppressions_workspace_email_idx").on(t.workspaceId, t.email)],
);

export const senderLists = pgTable(
  "sender_lists",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: senderListKindEnum("kind").notNull(),
    // Either a full address or a bare domain.
    value: text("value").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("sender_lists_unique_idx").on(t.workspaceId, t.kind, t.value),
  ],
);

// Who moved a sending domain's mail to Spam, across all of HelloBox. The domain is kept
// as a SHA-256, so this isn't a readable list of who writes to our users. A domain's spam
// score is how many people reported it recently: each person counts once, so one angry
// user can't send a domain to Spam for everyone.
export const domainSpamReports = pgTable(
  "domain_spam_reports",
  {
    domainHash: text("domain_hash").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Reporting again refreshes this, so old reports age out of the score.
    reportedAt: time("reported_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.domainHash, t.userId] })],
);

// A person's "never send to Spam" domains. Mail from one doesn't land in Spam for a
// mailbox this person reads, unless the workspace blocked the sender.
export const spamExemptions = pgTable(
  "spam_exemptions",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.domain] })],
);

export const threadNotes = pgTable(
  "thread_notes",
  {
    id: id(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    // Teammates @mentioned in the body, by user id. Each was notified.
    mentions: jsonb("mentions").$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [index("thread_notes_thread_idx").on(t.threadId)],
);

// Composing and sending.

export const uploadStatusEnum = pgEnum("upload_status", [
  "pending",
  "ready",
  "attached",
]);

export const uploads = pgTable(
  "uploads",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // Null for a file an app sent with a support message.
    userId: text("user_id")
      .references(() => user.id, { onDelete: "cascade" }),
    storageKey: text("storage_key").notNull(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    multipartUploadId: text("multipart_upload_id"),
    status: uploadStatusEnum("status").notNull().default("pending"),
    expiresAt: time("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("uploads_status_idx").on(t.status, t.expiresAt)],
);

export const drafts = pgTable(
  "drafts",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    threadId: text("thread_id").references(() => threads.id, {
      onDelete: "cascade",
    }),
    replyToMessageId: text("reply_to_message_id").references(
      () => messages.id,
      { onDelete: "set null" },
    ),
    toRecipients: jsonb("to_recipients").$type<string[]>().notNull().default([]),
    ccRecipients: jsonb("cc_recipients").$type<string[]>().notNull().default([]),
    bccRecipients: jsonb("bcc_recipients")
      .$type<string[]>()
      .notNull()
      .default([]),
    subject: text("subject").notNull().default(""),
    html: text("html").notNull().default(""),
    uploadIds: jsonb("upload_ids").$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("drafts_user_idx").on(t.workspaceId, t.userId)],
);

export const outboxStatusEnum = pgEnum("outbox_status", [
  "scheduled",
  "sending",
  "sent",
  "canceled",
  "failed",
]);

export const outbox = pgTable(
  "outbox",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    threadId: text("thread_id").references(() => threads.id, {
      onDelete: "cascade",
    }),
    replyToMessageId: text("reply_to_message_id").references(
      () => messages.id,
      { onDelete: "set null" },
    ),
    toRecipients: jsonb("to_recipients").$type<string[]>().notNull(),
    ccRecipients: jsonb("cc_recipients").$type<string[]>().notNull().default([]),
    bccRecipients: jsonb("bcc_recipients")
      .$type<string[]>()
      .notNull()
      .default([]),
    subject: text("subject").notNull().default(""),
    html: text("html").notNull().default(""),
    uploadIds: jsonb("upload_ids").$type<string[]>().notNull().default([]),
    status: outboxStatusEnum("status").notNull().default("scheduled"),
    sendAt: time("send_at").notNull(),
    providerMessageId: text("provider_message_id"),
    messageId: text("message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    error: text("error"),
    agentTokenId: text("agent_token_id").references(() => agentTokens.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("outbox_due_idx").on(t.status, t.sendAt)],
);

// Delivery of webhooks is at-least-once, so events are unique on the Svix id.

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: id(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    providerEventId: text("provider_event_id").notNull(),
    type: text("type").notNull(),
    emailId: text("email_id"),
    payload: jsonb("payload").notNull(),
    processedAt: time("processed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("webhook_events_unique_idx").on(
      t.connectionId,
      t.providerEventId,
    ),
  ],
);

export const aiProviders = pgTable(
  "ai_providers",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    baseUrl: text("base_url"),
    apiKeyEnc: text("api_key_enc").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("ai_providers_user_idx").on(t.userId)],
);

// Agents. A token lets an MCP client act as one user in one workspace, with
// that user's live role and mailbox access. Only a hash of the token is kept.

export const agentTokens = pgTable(
  "agent_tokens",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    // The last characters, so people can tell their tokens apart.
    hint: text("hint").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
    expiresAt: time("expires_at").notNull(),
    lastUsedAt: time("last_used_at"),
    revokedAt: time("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("agent_tokens_hash_idx").on(t.tokenHash),
    index("agent_tokens_user_idx").on(t.userId, t.workspaceId),
  ],
);

// Campaigns. Contacts live here and are mirrored to a Resend Segment on each of the
// workspace's connections, so Resend Broadcasts can send to them.

// Notifications: each person picks where they hear about new mail, per workspace.

export const notificationKindEnum = pgEnum("notification_kind", [
  "email",
  "discord",
  "slack",
  "telegram",
  "ntfy",
  "webhook",
  "browser",
]);

// Destination details (webhook URLs, chat ids, push subscriptions, tokens) are encrypted
// in configEnc. Channels that keep failing turn themselves off with a reason.
export const notificationChannels = pgTable(
  "notification_channels",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: notificationKindEnum("kind").notNull(),
    label: text("label").notNull(),
    configEnc: text("config_enc").notNull(),
    // Sender, recipient and an excerpt, or only "New mail in support@".
    preview: boolean("preview").notNull().default(true),
    enabled: boolean("enabled").notNull().default(true),
    failures: integer("failures").notNull().default(0),
    disabledReason: text("disabled_reason"),
    lastSentAt: time("last_sent_at"),
    createdAt: createdAt(),
  },
  (t) => [index("notification_channels_user_idx").on(t.workspaceId, t.userId)],
);

export const notificationSettings = pgTable(
  "notification_settings",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Null means every mailbox this person can read, including ones added later.
    mailboxIds: jsonb("mailbox_ids").$type<string[] | null>(),
    primaryOnly: boolean("primary_only").notNull().default(false),
    // The hourly email digest covers mail that arrived after this.
    digestSentAt: time("digest_sent_at"),
    // Email when a teammate does something this person should see right away, like
    // assigning them a conversation. The in-app notification shows either way.
    teamEmails: boolean("team_emails").notNull().default(true),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
);

// In-app notifications: something a teammate did that this person should see, listed
// under Notifications in the app and emailed unless they turned team emails off.
export const userNotificationKindEnum = pgEnum("user_notification_kind", ["assigned", "mentioned"]);

export const userNotifications = pgTable(
  "user_notifications",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // Who it's for.
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Who did it. Kept when they leave, as "Someone".
    actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
    kind: userNotificationKindEnum("kind").notNull(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    // The note a mention is in.
    noteId: text("note_id").references(() => threadNotes.id, { onDelete: "cascade" }),
    readAt: time("read_at"),
    emailedAt: time("emailed_at"),
    createdAt: createdAt(),
  },
  (t) => [index("user_notifications_user_idx").on(t.workspaceId, t.userId, t.createdAt)],
);

export const contacts = pgTable(
  "contacts",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    fields: jsonb("fields").$type<Record<string, string>>().notNull().default({}),
    unsubscribedAt: time("unsubscribed_at"),
    // Behind updatedAt means Resend hasn't seen the latest change yet.
    syncedAt: time("synced_at"),
    syncError: text("sync_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("contacts_workspace_email_idx").on(t.workspaceId, t.email),
    index("contacts_workspace_created_idx").on(t.workspaceId, t.createdAt),
  ],
);

export const contactSegments = pgTable(
  "contact_segments",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    segmentId: text("segment_id").notNull(),
    propertyKeys: jsonb("property_keys").$type<string[]>().notNull().default([]),
    // Null until every contact has been pushed to this segment once.
    fullSyncAt: time("full_sync_at"),
    optOutsCheckedAt: time("opt_outs_checked_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("contact_segments_connection_idx").on(t.connectionId)],
);

export const emailTemplates = pgTable(
  "email_templates",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    subject: text("subject").notNull().default(""),
    html: text("html").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("email_templates_workspace_idx").on(t.workspaceId, t.name)],
);

export const campaignStatusEnum = pgEnum("campaign_status", [
  "draft",
  "queued",
  "sending",
  "sent",
  "failed",
]);

export const campaigns = pgTable(
  "campaigns",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    mailboxId: text("mailbox_id").references(() => mailboxes.id, { onDelete: "set null" }),
    templateId: text("template_id").references(() => emailTemplates.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    subject: text("subject").notNull().default(""),
    // The source for this send only. Editing it never touches the saved template.
    html: text("html").notNull().default(""),
    values: jsonb("values").$type<Record<string, string>>().notNull().default({}),
    status: campaignStatusEnum("status").notNull().default("draft"),
    broadcastId: text("broadcast_id"),
    recipientCount: integer("recipient_count"),
    // Contacts left out because their address is suppressed.
    suppressedCount: integer("suppressed_count"),
    error: text("error"),
    sentAt: time("sent_at"),
    agentTokenId: text("agent_token_id").references(() => agentTokens.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("campaigns_workspace_idx").on(t.workspaceId, t.createdAt)],
);

// Providers without broadcasts (SES) get one row per recipient. The unique index makes
// the fan-out resumable: a retry skips everyone who already has a row.

export const deliveryStatusEnum = pgEnum("campaign_delivery_status", [
  "sending",
  "sent",
  "failed",
]);

export const campaignDeliveries = pgTable(
  "campaign_deliveries",
  {
    id: id(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    contactId: text("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    email: text("email").notNull(),
    status: deliveryStatusEnum("status").notNull().default("sending"),
    providerMessageId: text("provider_message_id"),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("campaign_deliveries_recipient_idx").on(t.campaignId, t.email),
    index("campaign_deliveries_message_idx").on(t.providerMessageId),
  ],
);

// Platform admin. Admins are the emails in ADMIN_EMAILS. The admin tool signs in
// through the browser and gets a short-lived token that only the admin API takes.

export const adminAuthCodes = pgTable(
  "admin_auth_codes",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    // The PKCE challenge the terminal sent, so only it can trade the code.
    challenge: text("challenge").notNull(),
    expiresAt: time("expires_at").notNull(),
    usedAt: time("used_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("admin_auth_codes_hash_idx").on(t.codeHash)],
);

export const adminSessions = pgTable(
  "admin_sessions",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: time("expires_at").notNull(),
    revokedAt: time("revoked_at"),
    lastUsedAt: time("last_used_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("admin_sessions_hash_idx").on(t.tokenHash)],
);

export const adminActions = pgTable(
  "admin_actions",
  {
    id: id(),
    adminUserId: text("admin_user_id").references(() => user.id, { onDelete: "set null" }),
    adminEmail: text("admin_email").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    targetLabel: text("target_label"),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [index("admin_actions_created_idx").on(t.createdAt)],
);

// Providers people asked for, from the landing page or the connect screen. Signed-in
// requests keep their workspace, so we can tell them when it ships.
export const providerRequests = pgTable(
  "provider_requests",
  {
    id: id(),
    workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    provider: text("provider").notNull(),
    details: text("details"),
    receivesMail: boolean("receives_mail"),
    email: text("email"),
    source: text("source").$type<"landing" | "app">().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("provider_requests_created_idx").on(t.createdAt)],
);

// Support: messages from a developer's app become conversations, answered by email. The
// conversation's mail lives in threads and messages like any other; these tables add who
// the customer is and which messages they wrote.

export const supportInboxes = pgTable(
  "support_inboxes",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // Always a shared mailbox.
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Where events go, signed with the secret. Never a private address.
    webhookUrl: text("webhook_url"),
    webhookSecretEnc: text("webhook_secret_enc"),
    // A failing endpoint is tried once per pause, which doubles each time, so it never
    // holds up the queue.
    webhookFailures: integer("webhook_failures").notNull().default(0),
    webhookPausedUntil: time("webhook_paused_until"),
    webhookError: text("webhook_error"),
    // Sites that may show the hosted page in a frame, as origins. Empty: none may.
    allowedOrigins: jsonb("allowed_origins").$type<string[]>().notNull().default([]),
    // The public form's key. Public by design: it can only start unverified conversations.
    // Null: the form is off.
    formKey: text("form_key"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("support_inboxes_workspace_idx").on(t.workspaceId),
    index("support_inboxes_mailbox_idx").on(t.mailboxId),
    uniqueIndex("support_inboxes_form_key_idx").on(t.formKey),
  ],
);

// A secret key of one support inbox, for a developer's server. Only its hash is kept.
export const supportKeys = pgTable(
  "support_keys",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    inboxId: text("inbox_id")
      .notNull()
      .references(() => supportInboxes.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull(),
    // The first characters, so people can tell their keys apart.
    prefix: text("prefix").notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    lastUsedAt: time("last_used_at"),
    revokedAt: time("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("support_keys_hash_idx").on(t.keyHash),
    index("support_keys_inbox_idx").on(t.inboxId),
  ],
);

export const supportStatusEnum = pgEnum("support_status", ["open", "in_progress", "solved"]);

export type SupportMetadata = Record<string, string | number | boolean | null>;

export const supportConversations = pgTable(
  "support_conversations",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    inboxId: text("inbox_id")
      .notNull()
      .references(() => supportInboxes.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    // The developer's own id for the customer. Unset means nobody vouched for them.
    externalUserId: text("external_user_id"),
    // Where replies go. For a verified customer, the newest address the developer gave.
    email: text("email").notNull(),
    name: text("name"),
    verified: boolean("verified").notNull().default(false),
    status: supportStatusEnum("status").notNull().default("open"),
    metadata: jsonb("metadata").$type<SupportMetadata>().notNull().default({}),
    // The newest message the customer can see, so their list is in order without
    // looking at the team's.
    lastMessageAt: time("last_message_at").notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("support_conversations_thread_idx").on(t.threadId),
    index("support_conversations_user_idx").on(t.inboxId, t.externalUserId, t.lastMessageAt),
    index("support_conversations_workspace_idx").on(t.workspaceId, t.status),
  ],
);

// The messages the customer wrote. An email answer is here only when it was really theirs;
// other mail in the conversation is the team's alone.
export const supportMessages = pgTable(
  "support_messages",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    inboxId: text("inbox_id")
      .notNull()
      .references(() => supportInboxes.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => supportConversations.id, { onDelete: "cascade" }),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    source: text("source").$type<"api" | "hosted" | "form" | "email">().notNull(),
    // Unset for email, which has its own protection from duplicates.
    idempotencyKey: text("idempotency_key"),
    contentHash: text("content_hash"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("support_messages_message_idx").on(t.messageId),
    uniqueIndex("support_messages_key_idx").on(t.inboxId, t.idempotencyKey),
    index("support_messages_conversation_idx").on(t.conversationId),
    index("support_messages_usage_idx").on(t.workspaceId, t.createdAt),
  ],
);

// What happened in a verified conversation, waiting to reach the developer's webhook. Ids
// only: the app reads the rest through the API, so nothing is kept twice.
export const supportWebhookEvents = pgTable(
  "support_webhook_events",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    inboxId: text("inbox_id")
      .notNull()
      .references(() => supportInboxes.id, { onDelete: "cascade" }),
    type: text("type").$type<"message.created" | "conversation.status_changed">().notNull(),
    payload: jsonb("payload").$type<Record<string, string>>().notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: time("next_attempt_at").notNull().defaultNow(),
    deliveredAt: time("delivered_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("support_webhook_events_due_idx").on(t.inboxId, t.nextAttemptAt).where(sql`${t.deliveredAt} is null`),
    index("support_webhook_events_created_idx").on(t.createdAt),
  ],
);

// A link to the hosted page, made by the developer's server for one signed-in customer. The
// link's token works once, within minutes, and becomes a session for an hour that the page
// keeps in memory. Only hashes are stored.
export const supportSessions = pgTable(
  "support_sessions",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    inboxId: text("inbox_id")
      .notNull()
      .references(() => supportInboxes.id, { onDelete: "cascade" }),
    // Revoking the key that made it ends the session too.
    keyId: text("key_id")
      .notNull()
      .references(() => supportKeys.id, { onDelete: "cascade" }),
    externalUserId: text("external_user_id").notNull(),
    email: text("email").notNull(),
    name: text("name"),
    tokenHash: text("token_hash").notNull(),
    expiresAt: time("expires_at").notNull(),
    usedAt: time("used_at"),
    sessionHash: text("session_hash"),
    sessionExpiresAt: time("session_expires_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("support_sessions_token_idx").on(t.tokenHash),
    uniqueIndex("support_sessions_session_idx").on(t.sessionHash),
    index("support_sessions_expires_idx").on(t.expiresAt),
  ],
);
