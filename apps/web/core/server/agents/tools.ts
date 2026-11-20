import { escapeHtml } from "@hellobox/mail";
import { AppError } from "nezt";
import { z } from "zod";
import type { BillingErrorDetails } from "@/core/billing-errors";
import { BILLING_PATH } from "@/core/billing-errors";
import type { ActionMap } from "../actions-manifest";
import type { AgentScope } from "@/core/agent-scopes";

// The app's own actions, called as the agent's user. Tools never reach the
// database themselves, so every check the app makes applies to agents too.
export type AgentActions = Pick<
  ActionMap,
  | "/app/bootstrap"
  | "/threads/list"
  | "/threads/get"
  | "/threads/update"
  | "/threads/label"
  | "/threads/note"
  | "/labels/create"
  | "/drafts/save"
  | "/drafts/list"
  | "/drafts/delete"
  | "/mail/send"
  | "/mail/cancel"
  | "/mail/scheduled"
  | "/contacts/list"
  | "/contacts/find"
  | "/contacts/save"
  | "/contacts/delete"
  | "/contacts/unsubscribe"
  | "/templates/list"
  | "/templates/save"
  | "/templates/delete"
  | "/campaigns/list"
  | "/campaigns/send"
  | "/campaigns/delete"
  | "/connections/domains/add"
  | "/connections/domains/records"
  | "/connections/domains/apply-dns"
  | "/domains/remove"
>;

export interface AgentTool {
  name: string;
  title: string;
  description: string;
  scope: AgentScope;
  input: z.ZodObject;
  destructive?: boolean;
  run: (args: never, actions: AgentActions) => Promise<unknown>;
  // What the audit log names as the thing acted on.
  target?: (args: never, result: never) => string | undefined;
}

const tool = <S extends z.ZodObject, R>(definition: {
  name: string;
  title: string;
  description: string;
  scope: AgentScope;
  input: S;
  destructive?: boolean;
  run: (args: z.output<S>, actions: AgentActions) => Promise<R>;
  target?: (args: z.output<S>, result: Awaited<R>) => string | undefined;
}) => definition as unknown as AgentTool;

const VIEWS = [
  "inbox", "starred", "snoozed", "sent", "archive", "spam", "trash", "all", "important", "assigned", "unassigned",
] as const;
const CATEGORIES = ["primary", "notifications", "purchases", "newsletters"] as const;

const addresses = z.array(z.email()).max(50).default([]);

const body = {
  text: z.string().max(200_000).optional().describe("Plain text body. Use this or html."),
  html: z.string().max(1_500_000).optional().describe("HTML body. Use this or text."),
};

// Plain text keeps its paragraphs and line breaks once it's HTML.
export function textToHtml(text: string) {
  return text
    .trim()
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

// Enough to read an HTML-only email. Agents get text, which is far shorter.
export function htmlToText(html: string) {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const bodyHtml = (args: { text?: string; html?: string }) =>
  args.html ?? (args.text ? textToHtml(args.text) : "");

type Thread = Awaited<ReturnType<AgentActions["/threads/get"]>>;
type ThreadMessage = Thread["messages"][number];

const summarizeMessage = (message: ThreadMessage) => ({
  id: message.id,
  direction: message.direction,
  from: message.fromName ? `${message.fromName} <${message.fromAddress}>` : message.fromAddress,
  to: message.toRecipients.map((r) => r.address),
  cc: message.ccRecipients.map((r) => r.address),
  replyTo: message.replyTo,
  subject: message.subject,
  sentAt: message.sentAt,
  text: message.textBody ?? htmlToText(message.htmlBody ?? ""),
  attachments: message.attachments.map((file) => ({ filename: file.filename, size: file.size })),
  deliveryStatus: message.deliveryStatus,
  sentByAgent: Boolean(message.agentTokenId),
});

// The same recipients the app fills in when someone presses Reply or Reply all.
export function replyRecipients(message: ThreadMessage, mailboxAddress: string | undefined, all: boolean) {
  const to = message.direction === "outbound"
    ? message.toRecipients.map((r) => r.address)
    : message.replyTo.length ? message.replyTo : [message.fromAddress];
  const cc = all
    ? [...message.toRecipients, ...message.ccRecipients]
        .map((r) => r.address)
        .filter((address) => address !== mailboxAddress && !to.includes(address))
    : [];
  return { to, cc };
}

// Most workspaces have one SES connection, so agents needn't look its id up first.
async function onlySesConnection(actions: AgentActions) {
  const data = await actions["/app/bootstrap"]();
  const ses = data.connections.filter((c) => c.provider === "ses" && c.status === "active");
  if (ses.length === 1) return ses[0]!.id;
  throw new AppError(
    ses.length ? "There's more than one Amazon SES connection. Pass connectionId from list_domains." : "This workspace has no active Amazon SES connection.",
    "BAD_REQUEST",
    400,
  );
}

const replySubject = (subject: string) => (/^re:/i.test(subject) ? subject : `Re: ${subject}`);

export const agentTools: AgentTool[] = [
  // Reading.
  tool({
    name: "get_workspace",
    title: "Get workspace",
    description:
      "Who you're acting for, their role, the workspace's plan, and the mailboxes and labels they can use. Call this first to find mailbox and label ids.",
    scope: "read",
    input: z.object({}),
    run: async (_args, actions) => {
      const data = await actions["/app/bootstrap"]();
      return {
        user: { name: data.user.name, email: data.user.email },
        workspace: { id: data.workspace.id, name: data.workspace.name, plan: data.entitlements.plan },
        role: data.role,
        mailboxes: data.mailboxes.map((m) => ({ id: m.id, address: m.address, displayName: m.displayName })),
        labels: data.labels.map((l) => ({ id: l.id, name: l.name })),
        counts: data.counts,
      };
    },
  }),
  tool({
    name: "list_threads",
    title: "List conversations",
    description:
      "List conversations in a view (inbox by default), newest first, 40 at a time. \"assigned\" is what's assigned to the user, \"unassigned\" is open shared mail nobody has taken. Pass nextCursor back as cursor for the next page.",
    scope: "read",
    input: z.object({
      view: z.enum(VIEWS).default("inbox"),
      category: z.enum(CATEGORIES).optional(),
      mailboxId: z.string().optional(),
      labelId: z.string().optional(),
      unreadOnly: z.boolean().optional(),
      cursor: z.iso.datetime().optional(),
    }),
    run: async (args, actions) => summarizeThreads(await actions["/threads/list"](args)),
  }),
  tool({
    name: "search_threads",
    title: "Search conversations",
    description:
      "Search conversations by words in the subject, body or sender. Searches every view except spam and trash unless you pass one.",
    scope: "read",
    input: z.object({
      query: z.string().trim().min(1).max(200),
      view: z.enum(VIEWS).default("all"),
      mailboxId: z.string().optional(),
      cursor: z.iso.datetime().optional(),
    }),
    run: async ({ query, ...args }, actions) =>
      summarizeThreads(await actions["/threads/list"]({ ...args, q: query })),
  }),
  tool({
    name: "get_thread",
    title: "Read a conversation",
    description: "Read every message in a conversation, with notes and labels. Doesn't mark it as read.",
    scope: "read",
    input: z.object({ threadId: z.string() }),
    run: async ({ threadId }, actions) => {
      const detail = await actions["/threads/get"]({ id: threadId });
      return {
        thread: {
          id: detail.thread.id,
          subject: detail.thread.subject,
          mailboxId: detail.thread.mailboxId,
          folder: detail.thread.folder,
          category: detail.thread.category,
          important: detail.thread.important,
          assignedTo: detail.thread.assignedTo,
        },
        starred: detail.starred,
        labels: detail.labels,
        notes: detail.notes,
        messages: detail.messages.map(summarizeMessage),
      };
    },
  }),
  tool({
    name: "list_drafts",
    title: "List drafts",
    description: "List the user's saved drafts.",
    scope: "read",
    input: z.object({}),
    run: (_args, actions) => actions["/drafts/list"](),
  }),
  tool({
    name: "list_scheduled",
    title: "List scheduled emails",
    description: "List emails the user has scheduled, and any that failed to send.",
    scope: "read",
    input: z.object({}),
    run: (_args, actions) => actions["/mail/scheduled"](),
  }),
  tool({
    name: "list_contacts",
    title: "List contacts",
    description: "List or search campaign contacts, 50 per page.",
    scope: "read",
    input: z.object({
      query: z.string().trim().max(200).default(""),
      page: z.number().int().min(0).default(0),
    }),
    run: (args, actions) => actions["/contacts/list"](args),
  }),
  tool({
    name: "find_contact",
    title: "Find a contact",
    description: "Look up one contact by email address.",
    scope: "read",
    input: z.object({ email: z.string().trim().max(320) }),
    run: (args, actions) => actions["/contacts/find"](args),
  }),
  tool({
    name: "list_templates",
    title: "List templates",
    description:
      "List saved email templates. Templates print contact fields like {{ contact.first_name | default(\"there\") }}, values filled in when sending like {{ headline }}, and branch with {% if %}...{% else %}...{% endif %}.",
    scope: "read",
    input: z.object({}),
    run: (_args, actions) => actions["/templates/list"](),
  }),
  tool({
    name: "list_campaigns",
    title: "List campaigns",
    description: "List campaigns with their status and recipient counts.",
    scope: "read",
    input: z.object({}),
    run: (_args, actions) => actions["/campaigns/list"](),
  }),

  // Organizing and writing.
  tool({
    name: "move_threads",
    title: "Move conversations",
    description: "Move conversations to the inbox, archive, spam or trash. Archive is the usual way to clear the inbox.",
    scope: "write",
    input: z.object({
      threadIds: z.array(z.string()).min(1).max(100),
      folder: z.enum(["inbox", "archive", "spam", "trash"]),
    }),
    run: ({ threadIds, folder }, actions) => actions["/threads/update"]({ ids: threadIds, folder }),
    target: ({ threadIds }) => threadIds.join(","),
  }),
  tool({
    name: "mark_threads",
    title: "Mark conversations",
    description: "Mark conversations read or unread, star them, flag them important, snooze them, or recategorize them.",
    scope: "write",
    input: z.object({
      threadIds: z.array(z.string()).min(1).max(100),
      read: z.boolean().optional(),
      starred: z.boolean().optional(),
      important: z.boolean().optional(),
      snoozedUntil: z.iso.datetime().nullable().optional().describe("When to bring it back, or null to unsnooze."),
      category: z.enum(CATEGORIES).optional(),
    }),
    run: ({ threadIds, ...patch }, actions) => actions["/threads/update"]({ ids: threadIds, ...patch }),
    target: ({ threadIds }) => threadIds.join(","),
  }),
  tool({
    name: "label_thread",
    title: "Label a conversation",
    description: "Add or remove a label on a conversation. Find label ids with get_workspace.",
    scope: "write",
    input: z.object({ threadId: z.string(), labelId: z.string(), applied: z.boolean().default(true) }),
    run: ({ threadId, ...args }, actions) => actions["/threads/label"]({ ids: [threadId], ...args }),
    target: ({ threadId }) => threadId,
  }),
  tool({
    name: "create_label",
    title: "Create a label",
    description: "Create a workspace label.",
    scope: "write",
    input: z.object({ name: z.string().trim().min(1).max(50), color: z.string().max(20).optional() }),
    run: (args, actions) => actions["/labels/create"](args),
    target: (_args, label) => label.id,
  }),
  tool({
    name: "add_note",
    title: "Add a note",
    description: "Add an internal note to a conversation. Only the team sees notes.",
    scope: "write",
    input: z.object({ threadId: z.string(), body: z.string().trim().min(1).max(5000) }),
    run: (args, actions) => actions["/threads/note"](args),
    target: ({ threadId }) => threadId,
  }),
  tool({
    name: "save_draft",
    title: "Save a draft",
    description:
      "Save a new draft, or update one by passing its id. The user can review and send it from the app. To draft a reply, pass the threadId and the replyToMessageId of the message being answered.",
    scope: "write",
    input: z.object({
      id: z.string().optional(),
      mailboxId: z.string(),
      threadId: z.string().optional(),
      replyToMessageId: z.string().optional(),
      to: addresses,
      cc: addresses,
      bcc: addresses,
      subject: z.string().max(998).default(""),
      ...body,
    }),
    run: ({ text: _text, html: _html, ...args }, actions) =>
      actions["/drafts/save"]({ ...args, html: bodyHtml({ text: _text, html: _html }), uploadIds: [] }),
    target: (_args, draft) => draft.id,
  }),
  tool({
    name: "delete_draft",
    title: "Delete a draft",
    description: "Delete one of the user's drafts.",
    scope: "write",
    destructive: true,
    input: z.object({ id: z.string() }),
    run: (args, actions) => actions["/drafts/delete"](args),
    target: ({ id }) => id,
  }),
  tool({
    name: "save_contact",
    title: "Save a contact",
    description:
      "Add a contact, or update one by passing its id. Custom fields use lowercase names like company or plan_name.",
    scope: "write",
    input: z.object({
      id: z.string().optional(),
      email: z.email(),
      firstName: z.string().max(200).nullish(),
      lastName: z.string().max(200).nullish(),
      fields: z.record(z.string(), z.string().max(1_000)).default({}),
    }),
    run: (args, actions) => actions["/contacts/save"](args),
    target: ({ email }) => email,
  }),
  tool({
    name: "delete_contacts",
    title: "Delete contacts",
    description: "Delete contacts by id.",
    scope: "write",
    destructive: true,
    input: z.object({ ids: z.array(z.string()).min(1).max(50) }),
    run: (args, actions) => actions["/contacts/delete"](args),
    target: ({ ids }) => ids.join(","),
  }),
  tool({
    name: "unsubscribe_contact",
    title: "Unsubscribe a contact",
    description: "Stop sending campaigns to a contact.",
    scope: "write",
    input: z.object({ id: z.string() }),
    run: (args, actions) => actions["/contacts/unsubscribe"](args),
    target: ({ id }) => id,
  }),
  tool({
    name: "save_template",
    title: "Save a template",
    description:
      "Create a template, or update one by passing its id. Use {{ contact.first_name }}, {{ contact.last_name }}, {{ contact.email }} or {{ contact.<custom_field> }} for contact fields, {{ name }} for values filled in when sending, and {{ unsubscribe_url }} for the unsubscribe link.",
    scope: "write",
    input: z.object({
      id: z.string().optional(),
      name: z.string().trim().min(1).max(120),
      subject: z.string().max(998).default(""),
      html: z.string().min(1).max(1_000_000),
    }),
    run: (args, actions) => actions["/templates/save"](args),
    target: (_args, template) => template.id,
  }),
  tool({
    name: "delete_template",
    title: "Delete a template",
    description: "Delete a saved template. Campaigns already sent keep their own copy.",
    scope: "write",
    destructive: true,
    input: z.object({ id: z.string() }),
    run: (args, actions) => actions["/templates/delete"](args),
    target: ({ id }) => id,
  }),
  // Domains. These are admin actions in the app, so only an admin's agent can use them.
  tool({
    name: "list_domains",
    title: "List domains",
    description:
      "List the workspace's domains with their provider, status, and whether they send and receive, plus the provider connections. Use a connection's id to add a domain.",
    scope: "read",
    input: z.object({}),
    run: async (_args, actions) => {
      const data = await actions["/app/bootstrap"]();
      const connections = data.connections.filter((c) => c.status !== "disconnected");
      return {
        connections: connections.map((c) => ({ id: c.id, provider: c.provider, status: c.status, region: c.region })),
        domains: data.domains.filter((d) => !d.removedAt).map((d) => ({
          id: d.id,
          name: d.name,
          connectionId: d.connectionId,
          provider: connections.find((c) => c.id === d.connectionId)?.provider ?? null,
          status: d.status,
          enabled: d.enabled,
          sending: d.sendingEnabled,
          receiving: d.receivingEnabled,
        })),
      };
    },
  }),
  tool({
    name: "add_domain",
    title: "Add a domain",
    description:
      "Add a domain to an Amazon SES connection and get the DNS records it needs. When the connection may write DNS (Route 53, or Cloudflare once connected), the records are added for you; otherwise give them to the person to add. Resend domains are added in Resend and show up here by themselves.",
    scope: "write",
    input: z.object({
      domain: z.string().trim().min(3).max(253).describe("Like example.com"),
      connectionId: z.string().optional().describe("The SES connection. Optional when there's only one."),
    }),
    run: async (args, actions) => {
      const connectionId = args.connectionId ?? (await onlySesConnection(actions));
      return actions["/connections/domains/add"]({ connectionId, domain: args.domain });
    },
    target: ({ domain }) => domain,
  }),
  tool({
    name: "get_domain_records",
    title: "Get a domain's DNS records",
    description:
      "The DNS records an SES domain needs (DKIM, bounce handling, DMARC and, when receiving, MX), and whether its DNS is on Route 53 or Cloudflare.",
    scope: "read",
    input: z.object({ domain: z.string(), connectionId: z.string().optional() }),
    run: async (args, actions) => {
      const connectionId = args.connectionId ?? (await onlySesConnection(actions));
      return actions["/connections/domains/records"]({ connectionId, domain: args.domain });
    },
  }),
  tool({
    name: "add_dns_records",
    title: "Add a domain's DNS records",
    description:
      "Write an SES domain's records to Route 53 or Cloudflare. Records the domain already has, like an MX pointing elsewhere or a DMARC policy, are left alone and listed as skipped. Cloudflare needs a person to connect it in Settings first.",
    scope: "write",
    input: z.object({
      domain: z.string(),
      host: z.enum(["route53", "cloudflare"]),
      connectionId: z.string().optional(),
    }),
    run: async (args, actions) => {
      const connectionId = args.connectionId ?? (await onlySesConnection(actions));
      return actions["/connections/domains/apply-dns"]({ connectionId, domain: args.domain, host: args.host });
    },
    target: ({ domain }) => domain,
  }),
  tool({
    name: "remove_domain",
    title: "Remove a domain",
    description:
      "Remove a domain from HelloBox by its id from list_domains. It stops counting toward the plan and, on Amazon SES, stops receiving here. Its mailboxes and mail stay. The domain itself stays in the SES or Resend account.",
    scope: "write",
    destructive: true,
    input: z.object({ id: z.string() }),
    run: (args, actions) => actions["/domains/remove"](args),
    target: ({ id }) => id,
  }),
  tool({
    name: "delete_campaign",
    title: "Delete a campaign",
    description: "Remove a campaign's record. A campaign that's sending can't be removed, and a sent one can't be recalled.",
    scope: "write",
    destructive: true,
    input: z.object({ id: z.string() }),
    run: (args, actions) => actions["/campaigns/delete"](args),
    target: ({ id }) => id,
  }),

  // Sending.
  tool({
    name: "send_email",
    title: "Send an email",
    description:
      "Send a new email from one of the user's mailboxes. It goes out after a 10 second undo window, or at sendAt if given. Returns an id you can pass to cancel_send.",
    scope: "send",
    input: z.object({
      mailboxId: z.string(),
      to: addresses,
      cc: addresses,
      bcc: addresses,
      subject: z.string().max(998).default(""),
      ...body,
      sendAt: z.iso.datetime().optional().describe("Schedule it for later."),
    }),
    run: ({ text, html, ...args }, actions) =>
      actions["/mail/send"]({ ...args, html: bodyHtml({ text, html }), uploadIds: [] }),
    target: (_args, item) => item.id,
  }),
  tool({
    name: "reply",
    title: "Reply to a conversation",
    description:
      "Reply to the latest message in a conversation, or to messageId, from the conversation's mailbox. Recipients are filled in the way the app's Reply and Reply all buttons do.",
    scope: "send",
    input: z.object({
      threadId: z.string(),
      messageId: z.string().optional(),
      replyAll: z.boolean().default(false),
      ...body,
      sendAt: z.iso.datetime().optional(),
    }),
    run: async ({ threadId, messageId, replyAll, text, html, sendAt }, actions) => {
      const [detail, workspace] = await Promise.all([
        actions["/threads/get"]({ id: threadId }),
        actions["/app/bootstrap"](),
      ]);
      const message = messageId
        ? detail.messages.find((m) => m.id === messageId)
        : detail.messages.at(-1);
      if (!message) throw new AppError("That message isn't in this conversation", "NOT_FOUND", 404);
      const mailbox = workspace.mailboxes.find((m) => m.id === detail.thread.mailboxId)?.address;
      const { to, cc } = replyRecipients(message, mailbox, replyAll);
      return actions["/mail/send"]({
        mailboxId: detail.thread.mailboxId,
        threadId,
        replyToMessageId: message.id,
        to,
        cc,
        bcc: [],
        subject: replySubject(message.subject),
        html: bodyHtml({ text, html }),
        uploadIds: [],
        sendAt,
      });
    },
    target: ({ threadId }) => threadId,
  }),
  tool({
    name: "send_draft",
    title: "Send a draft",
    description: "Send one of the user's saved drafts as it is.",
    scope: "send",
    input: z.object({ id: z.string(), sendAt: z.iso.datetime().optional() }),
    run: async ({ id, sendAt }, actions) => {
      const draft = (await actions["/drafts/list"]()).find((d) => d.id === id);
      if (!draft) throw new AppError("Draft not found", "NOT_FOUND", 404);
      return actions["/mail/send"]({
        draftId: draft.id,
        mailboxId: draft.mailboxId,
        threadId: draft.threadId,
        replyToMessageId: draft.replyToMessageId,
        to: draft.toRecipients,
        cc: draft.ccRecipients,
        bcc: draft.bccRecipients,
        subject: draft.subject,
        html: draft.html,
        uploadIds: draft.uploadIds,
        sendAt,
      });
    },
    target: ({ id }) => id,
  }),
  tool({
    name: "cancel_send",
    title: "Cancel a send",
    description: "Stop an email that's still in its undo window or scheduled for later.",
    scope: "send",
    input: z.object({ id: z.string() }),
    run: async (args, actions) => {
      await actions["/mail/cancel"](args);
      return { canceled: true };
    },
    target: ({ id }) => id,
  }),
  tool({
    name: "send_campaign",
    title: "Send a campaign",
    description:
      "Send a campaign to every subscribed contact through the workspace's email provider. This reaches the whole list and can't be recalled, so confirm with the user first.",
    scope: "send",
    input: z.object({
      name: z.string().trim().min(1).max(120),
      mailboxId: z.string(),
      templateId: z.string().optional(),
      subject: z.string().trim().min(1).max(998),
      html: z.string().min(1).max(1_000_000),
      values: z
        .record(z.string(), z.string().max(100_000))
        .default({})
        .describe("Fills {{ name }} placeholders that aren't contact fields."),
    }),
    run: (args, actions) => actions["/campaigns/send"](args),
    target: (_args, campaign) => campaign.id,
  }),
];

function summarizeThreads(result: Awaited<ReturnType<AgentActions["/threads/list"]>>) {
  return {
    threads: result.threads.map((thread) => ({
      id: thread.id,
      subject: thread.subject,
      snippet: thread.snippet,
      participants: thread.participants,
      mailbox: thread.mailboxAddress,
      folder: thread.folder,
      category: thread.category,
      unread: thread.unread,
      starred: thread.starred,
      important: thread.important,
      messageCount: thread.messageCount,
      lastMessageAt: thread.lastMessageAt,
      labels: thread.labels.map((label) => label.name),
      assignedTo: thread.assignee?.name ?? null,
    })),
    nextCursor: result.nextCursor,
  };
}

const PLAN_NAMES = { starter: "Starter", team: "Team", business: "Business" } as const;

// Billing errors say what to do next, since the agent can't click through to billing.
export function describeToolError(error: unknown, production = process.env.NODE_ENV === "production") {
  if (!(error instanceof AppError)) {
    if (error instanceof z.ZodError) return { code: "VALIDATION_ERROR", message: z.prettifyError(error) };
    return {
      code: "INTERNAL_ERROR",
      message: production || !(error instanceof Error) ? "Something went wrong. Please try again." : error.message,
    };
  }
  if (error.status >= 500 && production) {
    return { code: error.code, message: "Something went wrong. Please try again." };
  }
  const details = (error.details ?? {}) as BillingErrorDetails;
  let message = error.message;
  if ((error.code === "PLAN_REQUIRED" || error.code === "LIMIT_REACHED") && details.requiredPlan) {
    message += `. This needs the ${PLAN_NAMES[details.requiredPlan]} plan; the user can upgrade at ${BILLING_PATH}`;
  } else if (error.code === "BILLING_INACTIVE") {
    message += ` at ${BILLING_PATH}`;
  } else if (error.code === "VALIDATION_ERROR" && error.details) {
    message += `: ${JSON.stringify(error.details)}`;
  }
  return { code: error.code, message, ...(error.details ? { details: error.details } : {}) };
}
