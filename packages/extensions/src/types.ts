import type { MailProvider } from "@hellobox/providers";
import type { BetterAuthPlugin } from "better-auth";
import type { SQL } from "drizzle-orm";
import type { ComponentType } from "react";
import type { Metadata, MetadataRoute } from "next";

// What the app hands a slot. The app owns the real shapes (its workspace context, its
// connection rows); the slots only need to pass them through, so they stay open here.
export type PlanContext = object;
export type WorkspaceContext = object;
export type Connection = object;
export type HookContext = object;
export type AuthUser = { id: string; email: string; name?: string | null; [key: string]: unknown };
export type Mailbox = object;
// A nezt server action. Kept opaque so this package, which the worker also compiles, never
// pulls in nezt (it needs DOM types); apps/web registers them with its own typed registry.
export type AnyAction = object;

// ── billing: what a workspace may do. Absent = unlimited, every feature on, no prompts.
export type Feature =
  | "team" // invites, shared mailboxes, assignment, team views, the bell, "sent by", team emails
  | "roles" // making someone an admin
  | "instantEmail"; // instant email notifications (otherwise the hourly digest)
export type Limit = "members" | "domains" | "storageBytes" | "contacts";

export interface Entitlements {
  plan: string | null; // shown in the UI; null = no plan line anywhere
  limits: Record<Limit, number>; // Infinity = no limit
  features: Record<Feature, boolean>;
  prompts: boolean; // may the UI show upgrade prompts at all
}

export const UNLIMITED: Entitlements = {
  plan: null,
  limits: { members: Infinity, domains: Infinity, storageBytes: Infinity, contacts: Infinity },
  features: { team: true, roles: true, instantEmail: true },
  prompts: false,
};

export type Refusal =
  | { feature: Feature; featureName: string; message: string }
  | { limit: Limit | "free workspaces"; current: number; max: number; needed?: number; message: string }
  // Not something the person can fix by buying: say `message` as it is, as a billing
  // error that tells them to ask whoever manages the plan (a full workspace's invite).
  | { verbatim: true; message: string };

export interface BillingSlot {
  entitlements(workspaceId: string): Promise<Entitlements>;
  // The typed error for a refused check (PLAN_REQUIRED / LIMIT_REACHED / BILLING_MANAGE_REQUIRED),
  // so the client opens the upgrade dialog exactly as today.
  denied(ctx: PlanContext, refusal: Refusal): Error;
  canCreateWorkspace?(userId: string): Promise<Error | null>; // the 3 free workspaces rule
  // A message that stops a person's account from being deleted while they own workspaces
  // with a live subscription ("Cancel your subscription first"); null when it can go.
  beforeDeleteUser?(ownedWorkspaceIds: string[]): Promise<string | null>;
  // The typed error that stops a workspace from being deleted while it is subscribed, or null.
  beforeDeleteWorkspace?(workspaceId: string): Promise<Error | null>;
}

// ── events: core says what happened; cloud's audit log listens.
export const WORKSPACE_EVENTS = [
  "member.invited",
  "member.removed",
  "member.role_changed",
  "member.left",
  "member.mailboxes_updated",
  "domain.added",
  "domain.removed",
  "domain.restored",
  "domain.receiving_subdomain",
  "domain.claim_started",
  "domain.claim_notice",
  "domain.claim_dns_verified",
  "domain.claim_withdrawn",
  "domain.claim_kept",
  "domain.claim_stopped",
  "domain.claimed_away",
  "domain.claimed",
  "domain.access_requested",
  "mailbox.deleted",
  "mailbox.restored",
  "mailbox.shared",
  "mailbox.made_personal",
  "connection.disconnected",
  "connection.cloudflare_connected",
  "connection.cloudflare_disconnected",
  "connection.ses_started",
  "connection.ses_receiving",
  "connection.ses_production_requested",
  "connection.ses_test_recipient_added",
  "connection.postmark_connected",
  "connection.postmark_reconnected",
  "connection.postmark_receiving",
  "connection.mailgun_connected",
  "connection.mailgun_reconnected",
  "connection.mailgun_receiving",
  "suppression.removed",
  "sender.blocked",
  "agent.connected",
  "agent.revoked",
  "workspace.renamed",
  "workspace.transferred",
  "workspace.exported",
  "workspace.logo_changed",
  "workspace.logo_removed",
  "bounces.enabled",
  "bounces.disabled",
] as const;
export type WorkspaceEventName = (typeof WORKSPACE_EVENTS)[number];

// Agent tool calls over MCP are named after the tool (`agent.<tool>`), so the set is open.
export type AgentEventName = `agent.${string}`;

export interface WorkspaceEvent {
  name: WorkspaceEventName | AgentEventName;
  workspaceId: string;
  userId: string | null;
  target?: string | null;
  metadata?: Record<string, unknown>;
}
export type EventListener = (event: WorkspaceEvent) => Promise<void> | void;

// ── actions: extra nezt actions, merged into the action map.
export type ActionsSlot = Record<string, AnyAction>;

// ── jobs: extra BullMQ jobs and schedules (worker side).
export interface JobsSlot {
  handlers?: Record<string, (data: unknown) => Promise<unknown>>;
  // job name = id. `enabled: false` removes a schedule an earlier deploy may have left.
  schedules?: Array<{ id: string; every?: number; pattern?: string; tz?: string; enabled?: boolean }>;
  // Run during each 15-minute maintenance. `purgeWorkspaceFiles` deletes a workspace's stored files.
  maintenance?: Array<(tools: { purgeWorkspaceFiles(workspaceId: string): Promise<unknown> }) => Promise<void>>;
}

// ── auth: better-auth additions without core depending on them.
export interface AuthSlot {
  plugins?: BetterAuthPlugin[]; // sso(), anonymous()
  schema?: Record<string, unknown>; // { ssoProvider }
  providerCallbackPaths?: string[]; // SSO callbacks get the same 2FA challenge
  beforeSignIn?(ctx: HookContext): Promise<void>; // required-SSO check on /sign-in/email
  // Whether the workspace has a verified SSO provider for this domain (already lower-case), so
  // another workspace can't claim it. No hook = no.
  ssoOwnsDomain?(workspaceId: string, domain: string): Promise<boolean>;
  onUserCreated?(user: AuthUser, cookieHeader: string | null): Promise<{ skipWorkspace?: boolean }>;
}

// ── mail: the few places a time-limited sandbox workspace (the public demo) changes core
// behavior. Absent = nothing is a sandbox.
export interface MailSlot {
  // A provider kind core doesn't implement itself, by kind ("demo").
  providers?: Record<string, (connection: Connection) => MailProvider>;
  // Recipients (demo-…@ addresses) that mail from this kind of connection never delivers to.
  ignoreRecipient?(address: string, providerKind: string): boolean;
  // A kind whose mailboxes belong to its own workspace: returns the one that takes this mail
  // (`mailbox: null` = none), or undefined when the kind isn't handled here.
  ownMailbox?(input: { provider: string; workspaceId: string; recipients: string[] }): Promise<{ mailbox: Mailbox | null } | undefined>;
  // Throws to refuse an action. `sandbox`: the visitor or the workspace is a sandbox.
  guardRequest?(ctx: { request: Request | undefined; sandbox: boolean }): void;
  // The same for route handlers outside the action system (OAuth starts).
  refuseRoute?(ctx: { isAnonymous: boolean | null | undefined }): Response | null;
  // A reason to refuse a send before it is queued, or null.
  beforeSend?(ctx: {
    sandbox: boolean;
    workspaceId: string;
    mailboxId: string;
    recipients: string[];
    hasAttachments: boolean;
  }): Promise<string | null>;
  // A canned AI draft for a sandbox that has no AI key, or null for the real thing.
  cannedDraft?(ctx: { sandbox: boolean }): string | null;
}

// ── admin: cloud sections of the instance admin API. Absent = the open admin only.
export interface AdminSlot {
  // Added to /admin/auth/me's `sections`, so the terminal admin shows screens the server has.
  sections?: string[]; // e.g. ["billing", "provider-requests"]
  // Merged into the `workspaces` object of /admin/stats (workspaces by plan, paying, past due, MRR).
  stats?(): Promise<Record<string, unknown>>;
  // Extra fields for these workspaces, by id (plan, subscription): merged into the workspace list's
  // rows, a workspace's detail and a user's memberships.
  workspaceFields?(workspaceIds: string[]): Promise<Record<string, Record<string, unknown>>>;
  // Extra values for the workspace list's filter ("paying").
  workspaceFilters?: Record<string, SQL>;
  // How these people say they heard about us, as the signup digest shows it. Runs in the worker.
  signupSources?(userIds: string[]): Promise<Record<string, string | null>>;
}

// ── site: what the root layout and metadata routes need from the marketing site.
export interface SiteSlot {
  metadata?: Metadata; // share images, keywords; merged into the root layout's
  head?: ComponentType; // analytics scripts, and the window.hbTrack hook they define
  robots?(): MetadataRoute.Robots;
  sitemap?(): Promise<MetadataRoute.Sitemap>;
}

// ── proxy: what the app's proxy.ts asks the marketing site to do on every request.
export interface ProxyCookie {
  name: string;
  value: string;
  maxAge?: number;
  path?: string;
  sameSite?: "lax" | "strict" | "none";
  httpOnly?: boolean;
  secure?: boolean;
}
export interface ProxyHooks {
  // Runs first, for every method. A response ends the request (analytics short links, the
  // signed-in visit to the landing page).
  before(request: Request): Promise<Response | undefined>;
  // Runs for GET requests the app's own rules let through: cookies to set on the response.
  cookies(request: Request): ProxyCookie[];
}

export interface ServerExtensions {
  billing?: BillingSlot;
  events?: EventListener[];
  actions?: ActionsSlot;
  auth?: AuthSlot;
  mail?: MailSlot;
  admin?: AdminSlot;
  site?: SiteSlot;
  // Where people reach whoever runs this instance, when SUPPORT_EMAIL isn't set.
  supportEmail?: string;
  bootstrap?(ctx: WorkspaceContext): Promise<Record<string, unknown>>; // billing summary, demo details
}

export interface WorkerExtensions {
  admin?: Pick<AdminSlot, "signupSources">;
  billing?: BillingSlot;
  events?: EventListener[];
  jobs?: JobsSlot;
  mail?: MailSlot;
}

// What an entry file's default export may hold, and what getExtensions() returns once the
// "nothing registered" behavior is filled in.
export type Extensions = ServerExtensions & WorkerExtensions;
export type ResolvedExtensions = Omit<Required<Extensions>, "billing" | "bootstrap" | "auth" | "mail" | "admin" | "site" | "supportEmail"> &
  Pick<Extensions, "billing" | "bootstrap" | "auth" | "mail" | "admin" | "site" | "supportEmail">;
