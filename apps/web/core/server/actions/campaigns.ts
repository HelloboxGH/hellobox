import { campaigns, contacts, domains, emailTemplates, getDb, mailboxes, messages, threads, connections } from "@hellobox/db";
import {
  compileBroadcast,
  compileBroadcastSubject,
  isFieldKey,
  mergeSuggestions,
  TemplateError,
  templateVariables,
} from "@hellobox/mail";
import { enqueueCampaign, enqueueContactSync, enqueueContactUnsync } from "@hellobox/queue";
import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { badRequest, notFound } from "nezt";
import { z } from "zod";
import { workspaceAction } from "../builder";
import { contactLimitError } from "../contact-limit";
import { accessibleMailboxIds, assertMailboxAccess, type WorkspaceContext } from "../middlewares";

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const MAX_FIELDS = 50;
const PAGE_SIZE = 50;
const IMPORT_CHUNK = 2_000;

const optionalName = z
  .string()
  .trim()
  .max(200)
  .nullish()
  .transform((value) => value || null);

const fieldsInput = z
  .record(z.string(), z.string().trim().max(1_000))
  .default({})
  .refine((fields) => Object.keys(fields).length <= MAX_FIELDS, `Contacts can have up to ${MAX_FIELDS} custom fields`)
  .refine(
    (fields) => Object.keys(fields).every(isFieldKey),
    "Custom field names use lowercase letters, numbers and underscores, start with a letter, and can't be email, first_name or last_name",
  )
  // An empty value means the field isn't set.
  .transform((fields) => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== "")));

const contactInput = z.object({
  email: z.email().max(320).transform((email) => email.trim().toLowerCase()),
  firstName: optionalName,
  lastName: optionalName,
  fields: fieldsInput,
});

const syncSoon = (workspaceId: string) =>
  enqueueContactSync(workspaceId).catch((error: unknown) => {
    // The maintenance job retries anything still pending.
    console.error("[contacts] Couldn't queue a sync:", error);
  });

// Checked under a per-workspace lock, so two imports at once can't both fit under
// the limit and together go over it.
async function assertContactRoom(tx: Tx, ctx: WorkspaceContext, adding: number) {
  if (!Number.isFinite(ctx.entitlements.limits.contacts) || adding <= 0) return;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`contacts:${ctx.workspace.id}`}))`);
  const [row] = await tx
    .select({ count: count() })
    .from(contacts)
    .where(eq(contacts.workspaceId, ctx.workspace.id));
  const error = contactLimitError(ctx, row?.count ?? 0, adding);
  if (error) throw error;
}

const contactColumns = {
  id: contacts.id,
  email: contacts.email,
  firstName: contacts.firstName,
  lastName: contacts.lastName,
  fields: contacts.fields,
  unsubscribedAt: contacts.unsubscribedAt,
  syncedAt: contacts.syncedAt,
  syncError: contacts.syncError,
  updatedAt: contacts.updatedAt,
  createdAt: contacts.createdAt,
};

export const listContacts = workspaceAction("/contacts/list")
  .input(
    z.object({
      query: z.string().trim().max(200).default(""),
      page: z.number().int().min(0).max(100_000).default(0),
    }),
  )
  .handler(async ({ input, ctx }) => {
    const db = getDb();
    const pattern = `%${input.query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    const where = and(
      eq(contacts.workspaceId, ctx.workspace.id),
      input.query
        ? or(ilike(contacts.email, pattern), ilike(contacts.firstName, pattern), ilike(contacts.lastName, pattern))
        : undefined,
    );
    const [rows, [matching], [totals], keys] = await Promise.all([
      db
        .select(contactColumns)
        .from(contacts)
        .where(where)
        .orderBy(desc(contacts.createdAt), asc(contacts.id))
        .limit(PAGE_SIZE)
        .offset(input.page * PAGE_SIZE),
      db.select({ count: count() }).from(contacts).where(where),
      db
        .select({
          total: count(),
          unsubscribed: sql<number>`count(*) filter (where ${contacts.unsubscribedAt} is not null)::int`,
          pending: sql<number>`count(*) filter (where ${contacts.syncedAt} is null or ${contacts.updatedAt} > ${contacts.syncedAt})::int`,
        })
        .from(contacts)
        .where(eq(contacts.workspaceId, ctx.workspace.id)),
      db.execute<{ key: string }>(
        sql`select distinct jsonb_object_keys(${contacts.fields}) as key from ${contacts} where ${contacts.workspaceId} = ${ctx.workspace.id} order by key limit 200`,
      ),
    ]);
    const limit = ctx.entitlements.limits.contacts;
    return {
      contacts: rows,
      matching: matching?.count ?? 0,
      pageSize: PAGE_SIZE,
      total: totals?.total ?? 0,
      unsubscribed: totals?.unsubscribed ?? 0,
      pending: totals?.pending ?? 0,
      limit: Number.isFinite(limit) ? limit : null,
      fieldKeys: [...keys].map((row) => row.key),
    };
  });

// Fills contact fields in when a template is used for a one-to-one email.
export const findContact = workspaceAction("/contacts/find")
  .input(z.object({ email: z.string().trim().toLowerCase().max(320) }))
  .handler(async ({ input, ctx }) => {
    const [contact] = await getDb()
      .select({ email: contacts.email, firstName: contacts.firstName, lastName: contacts.lastName, fields: contacts.fields })
      .from(contacts)
      .where(and(eq(contacts.workspaceId, ctx.workspace.id), eq(contacts.email, input.email)));
    return contact ?? null;
  });

// Suggestions while typing a recipient: contacts, then people already written to from
// mailboxes this person can read, so nobody learns addresses from mail they can't see.
export const suggestRecipients = workspaceAction("/contacts/suggest")
  .input(z.object({ query: z.string().trim().max(200), exclude: z.array(z.string().max(320)).max(100).default([]) }))
  .handler(async ({ input, ctx }) => {
    if (!input.query) return [];
    const db = getDb();
    const pattern = `%${input.query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    const allowed = await accessibleMailboxIds(ctx);
    const [contactRows, sent] = await Promise.all([
      db
        .select({ email: contacts.email, firstName: contacts.firstName, lastName: contacts.lastName })
        .from(contacts)
        .where(
          and(
            eq(contacts.workspaceId, ctx.workspace.id),
            or(ilike(contacts.email, pattern), ilike(contacts.firstName, pattern), ilike(contacts.lastName, pattern)),
          ),
        )
        .orderBy(asc(contacts.email))
        .limit(8),
      allowed.length
        ? db.execute<{ address: string; name: string | null }>(sql`
            select lower(r->>'address') as address, max(r->>'name') as name
            from ${messages}
            join ${threads} on ${threads.id} = ${messages.threadId}
            cross join lateral jsonb_array_elements(${messages.toRecipients} || ${messages.ccRecipients}) r
            where ${messages.workspaceId} = ${ctx.workspace.id}
              and ${messages.direction} = 'outbound'
              and ${inArray(threads.mailboxId, allowed)}
              and (r->>'address' ilike ${pattern} or r->>'name' ilike ${pattern})
            group by 1
            order by count(*) desc, max(${messages.sentAt}) desc
            limit 16`)
        : [],
    ]);
    return mergeSuggestions(contactRows, [...sent], input.exclude);
  });

export const saveContact = workspaceAction("/contacts/save")
  .input(contactInput.extend({ id: z.string().optional() }))
  .handler(async ({ input, ctx }) => {
    const db = getDb();
    const values = { firstName: input.firstName, lastName: input.lastName, fields: input.fields };
    if (input.id) {
      // The address is who the contact is, in Resend too, so it doesn't change.
      const [updated] = await db
        .update(contacts)
        .set(values)
        .where(and(eq(contacts.id, input.id), eq(contacts.workspaceId, ctx.workspace.id)))
        .returning({ id: contacts.id });
      if (!updated) throw notFound("Contact");
      await syncSoon(ctx.workspace.id);
      return updated;
    }
    const created = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.workspaceId, ctx.workspace.id), eq(contacts.email, input.email)));
      if (existing) throw badRequest(`${input.email} is already a contact`);
      await assertContactRoom(tx, ctx, 1);
      const [row] = await tx
        .insert(contacts)
        .values({ ...values, email: input.email, workspaceId: ctx.workspace.id })
        .returning({ id: contacts.id });
      return row as { id: string };
    });
    await syncSoon(ctx.workspace.id);
    return created;
  });

// Sent in chunks by the browser. Existing contacts are updated without losing what
// the file leaves out, and an opt-out is never undone by an import.
export const importContacts = workspaceAction("/contacts/import")
  .input(z.object({ contacts: z.array(contactInput).min(1).max(IMPORT_CHUNK) }))
  .handler(async ({ input, ctx }) => {
    const byEmail = new Map<string, z.infer<typeof contactInput>>();
    for (const contact of input.contacts) byEmail.set(contact.email, contact);
    const rows = [...byEmail.values()];
    const result = await getDb().transaction(async (tx) => {
      const existing = await tx
        .select({ email: contacts.email })
        .from(contacts)
        .where(and(eq(contacts.workspaceId, ctx.workspace.id), inArray(contacts.email, rows.map((row) => row.email))));
      const known = new Set(existing.map((row) => row.email));
      const added = rows.filter((row) => !known.has(row.email)).length;
      await assertContactRoom(tx, ctx, added);
      await tx
        .insert(contacts)
        .values(
          rows.map((row) => ({
            workspaceId: ctx.workspace.id,
            email: row.email,
            firstName: row.firstName,
            lastName: row.lastName,
            fields: row.fields,
          })),
        )
        .onConflictDoUpdate({
          target: [contacts.workspaceId, contacts.email],
          set: {
            firstName: sql`coalesce(excluded.first_name, ${contacts.firstName})`,
            lastName: sql`coalesce(excluded.last_name, ${contacts.lastName})`,
            fields: sql`${contacts.fields} || excluded.fields`,
            updatedAt: new Date(),
          },
        });
      return { added, updated: rows.length - added };
    });
    await syncSoon(ctx.workspace.id);
    return result;
  });

export const deleteContacts = workspaceAction("/contacts/delete")
  .input(z.object({ ids: z.array(z.string()).min(1).max(PAGE_SIZE) }))
  .handler(async ({ input, ctx }) => {
    const removed = await getDb()
      .delete(contacts)
      .where(and(eq(contacts.workspaceId, ctx.workspace.id), inArray(contacts.id, input.ids)))
      .returning({ email: contacts.email });
    if (removed.length) {
      await enqueueContactUnsync(ctx.workspace.id, removed.map((row) => row.email));
    }
    return { deleted: removed.length };
  });

// There's no way back from here. Only the person can subscribe again.
export const unsubscribeContact = workspaceAction("/contacts/unsubscribe")
  .input(z.object({ id: z.string() }))
  .handler(async ({ input, ctx }) => {
    const [updated] = await getDb()
      .update(contacts)
      .set({ unsubscribedAt: new Date() })
      .where(
        and(eq(contacts.id, input.id), eq(contacts.workspaceId, ctx.workspace.id), isNull(contacts.unsubscribedAt)),
      )
      .returning({ id: contacts.id });
    if (!updated) throw notFound("Contact");
    await syncSoon(ctx.workspace.id);
    return updated;
  });

// Templates.

function assertTemplate(source: string, label: string) {
  try {
    return templateVariables(source);
  } catch (error) {
    if (error instanceof TemplateError) throw badRequest(`${label}: ${error.message}`);
    throw error;
  }
}

const templateInput = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1, "Give the template a name").max(120),
  subject: z.string().max(998).default(""),
  html: z.string().min(1, "The template is empty").max(1_000_000),
});

export const listTemplates = workspaceAction("/templates/list").handler(async ({ ctx }) =>
  getDb()
    .select()
    .from(emailTemplates)
    .where(eq(emailTemplates.workspaceId, ctx.workspace.id))
    .orderBy(asc(emailTemplates.name)),
);

export const saveTemplate = workspaceAction("/templates/save")
  .input(templateInput)
  .handler(async ({ input, ctx }) => {
    assertTemplate(input.subject, "Subject");
    assertTemplate(input.html, "Template");
    const db = getDb();
    const values = { name: input.name, subject: input.subject, html: input.html };
    if (input.id) {
      const [updated] = await db
        .update(emailTemplates)
        .set(values)
        .where(and(eq(emailTemplates.id, input.id), eq(emailTemplates.workspaceId, ctx.workspace.id)))
        .returning({ id: emailTemplates.id });
      if (!updated) throw notFound("Template");
      return updated;
    }
    const [created] = await db
      .insert(emailTemplates)
      .values({ ...values, workspaceId: ctx.workspace.id, createdBy: ctx.user.id })
      .returning({ id: emailTemplates.id });
    return created as { id: string };
  });

export const deleteTemplate = workspaceAction("/templates/delete")
  .input(z.object({ id: z.string() }))
  .handler(async ({ input, ctx }) => {
    await getDb()
      .delete(emailTemplates)
      .where(and(eq(emailTemplates.id, input.id), eq(emailTemplates.workspaceId, ctx.workspace.id)));
    return { ok: true };
  });

// Campaigns.

export const listCampaigns = workspaceAction("/campaigns/list").handler(async ({ ctx }) =>
  getDb()
    .select({
      id: campaigns.id,
      name: campaigns.name,
      subject: campaigns.subject,
      status: campaigns.status,
      recipientCount: campaigns.recipientCount,
      suppressedCount: campaigns.suppressedCount,
      error: campaigns.error,
      sentAt: campaigns.sentAt,
      createdAt: campaigns.createdAt,
      from: mailboxes.address,
    })
    .from(campaigns)
    .leftJoin(mailboxes, eq(mailboxes.id, campaigns.mailboxId))
    .where(eq(campaigns.workspaceId, ctx.workspace.id))
    .orderBy(desc(campaigns.createdAt))
    .limit(200),
);

export const sendCampaign = workspaceAction("/campaigns/send")
  .input(
    z.object({
      name: z.string().trim().min(1, "Give the campaign a name").max(120),
      mailboxId: z.string(),
      templateId: z.string().nullish(),
      subject: z.string().trim().min(1, "Add a subject").max(998),
      html: z.string().min(1, "The email is empty").max(1_000_000),
      values: z.record(z.string(), z.string().max(100_000)).default({}),
    }),
  )
  .handler(async ({ input, ctx }) => {
    await assertMailboxAccess(ctx, input.mailboxId);
    const db = getDb();
    const [sender] = await db
      .select({ sendingEnabled: domains.sendingEnabled, removedAt: domains.removedAt, status: connections.status })
      .from(mailboxes)
      .innerJoin(domains, eq(domains.id, mailboxes.domainId))
      .innerJoin(connections, eq(connections.id, domains.connectionId))
      .where(eq(mailboxes.id, input.mailboxId));
    if (!sender) throw notFound("Mailbox");
    if (sender.removedAt) throw badRequest("This mailbox's domain was removed from HelloBox. Add it again to send from it.");
    if (sender.status !== "active") throw badRequest("Reconnect your email provider in settings before sending a campaign");
    if (!sender.sendingEnabled) throw badRequest("This mailbox's domain can't send yet. Check its DNS records in settings.");
    try {
      compileBroadcast(input.html, input.values);
      compileBroadcastSubject(input.subject, input.values);
    } catch (error) {
      if (error instanceof TemplateError) throw badRequest(error.message);
      throw error;
    }
    const [subscribed] = await db
      .select({ count: count() })
      .from(contacts)
      .where(and(eq(contacts.workspaceId, ctx.workspace.id), isNull(contacts.unsubscribedAt)));
    if (!subscribed?.count) throw badRequest("Add some contacts before sending a campaign");

    let templateId = input.templateId ?? null;
    if (templateId) {
      const [template] = await db
        .select({ id: emailTemplates.id })
        .from(emailTemplates)
        .where(and(eq(emailTemplates.id, templateId), eq(emailTemplates.workspaceId, ctx.workspace.id)));
      templateId = template?.id ?? null;
    }
    const [campaign] = await db
      .insert(campaigns)
      .values({
        workspaceId: ctx.workspace.id,
        userId: ctx.user.id,
        mailboxId: input.mailboxId,
        templateId,
        name: input.name,
        subject: input.subject,
        html: input.html,
        values: input.values,
        status: "queued",
        agentTokenId: ctx.agent?.tokenId ?? null,
      })
      .returning({ id: campaigns.id });
    if (!campaign) throw new Error("Could not queue the campaign");
    try {
      await enqueueCampaign(campaign.id);
    } catch (error) {
      // Without a job it would never send, so it mustn't look queued.
      await db.delete(campaigns).where(eq(campaigns.id, campaign.id));
      throw error;
    }
    return campaign;
  });

export const deleteCampaign = workspaceAction("/campaigns/delete")
  .input(z.object({ id: z.string() }))
  .handler(async ({ input, ctx }) => {
    // Only the record goes. A broadcast Resend already sent can't be called back.
    const [removed] = await getDb()
      .delete(campaigns)
      .where(
        and(
          eq(campaigns.id, input.id),
          eq(campaigns.workspaceId, ctx.workspace.id),
          inArray(campaigns.status, ["draft", "sent", "failed"]),
        ),
      )
      .returning({ id: campaigns.id });
    if (!removed) throw badRequest("A campaign can't be removed while it's sending");
    return removed;
  });

export const campaignActions = {
  "/contacts/list": listContacts,
  "/contacts/find": findContact,
  "/contacts/suggest": suggestRecipients,
  "/contacts/save": saveContact,
  "/contacts/import": importContacts,
  "/contacts/delete": deleteContacts,
  "/contacts/unsubscribe": unsubscribeContact,
  "/templates/list": listTemplates,
  "/templates/save": saveTemplate,
  "/templates/delete": deleteTemplate,
  "/campaigns/list": listCampaigns,
  "/campaigns/send": sendCampaign,
  "/campaigns/delete": deleteCampaign,
};
