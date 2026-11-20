import { logoKey, deleteObject, streamToStorage } from "@hellobox/storage";
import { avatarTypes, MAX_AVATAR_BYTES, safeLogoUrl, sniffAvatarType } from "@/core/avatar";
import { getDb, mailboxes, mailboxMembers, members, threads, workspaces } from "@hellobox/db";
import { releasePersonalMailboxes, removeNotificationChannels } from "@hellobox/mail";
import { destroyWorkspace } from "@hellobox/mail";
import { and, eq, inArray, sql } from "drizzle-orm";
import { badRequest, forbidden, notFound } from "nezt";
import { z } from "zod";
import { getExtensions } from "@hellobox/extensions";
import { adminAction, userAction, workspaceAction } from "../builder";
import { emit } from "../events";
import type { WorkspaceContext } from "../middlewares";

const workspaceName = z.string().trim().min(1).max(80);

// Someone who rejoins later should start without their old access.
export async function clearMemberAccess(workspaceId: string, userId: string) {
  const db = getDb();
  await releasePersonalMailboxes(workspaceId, userId);
  await removeNotificationChannels(workspaceId, userId);
  const owned = db.select({ id: mailboxes.id }).from(mailboxes).where(eq(mailboxes.workspaceId, workspaceId));
  await db
    .delete(mailboxMembers)
    .where(and(eq(mailboxMembers.userId, userId), inArray(mailboxMembers.mailboxId, owned)));
  await db
    .update(threads)
    .set({ assignedTo: null })
    .where(and(eq(threads.workspaceId, workspaceId), eq(threads.assignedTo, userId)));
}

const membershipCount = async (userId: string) => {
  const [row] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(members)
    .where(eq(members.userId, userId));
  return row?.count ?? 0;
};

function requireOwner(ctx: WorkspaceContext) {
  if (ctx.role !== "owner") throw forbidden("Only the owner can do this");
}

export const createWorkspace = userAction("/workspaces/create")
  .input(z.object({ name: workspaceName }))
  .handler(async ({ input, ctx }) => {
    const db = getDb();
    // Cloud limits free workspaces per person; with no billing there's no limit.
    const refused = await getExtensions().billing?.canCreateWorkspace?.(ctx.user.id);
    if (refused) throw refused;
    const id = await db.transaction(async (tx) => {
      const [workspace] = await tx
        .insert(workspaces)
        .values({ name: input.name })
        .returning({ id: workspaces.id });
      if (!workspace) throw new Error("Could not create a workspace");
      await tx.insert(members).values({ workspaceId: workspace.id, userId: ctx.user.id, role: "owner" });
      return workspace.id;
    });
    return { id };
  });

export const renameWorkspace = adminAction("/workspace/rename")
  .input(z.object({ name: workspaceName }))
  .handler(async ({ input, ctx }) => {
    await getDb().update(workspaces).set({ name: input.name }).where(eq(workspaces.id, ctx.workspace.id));
    await emit(ctx, "workspace.renamed", ctx.workspace.id);
    return { ok: true };
  });

// Off by default. Bounces spend the workspace's sending credits and anyone can provoke
// them, so the settings and onboarding copy steer people away unless they need them.
export const setBounces = adminAction("/workspace/bounces")
  .input(z.object({ enabled: z.boolean() }))
  .handler(async ({ input, ctx }) => {
    await getDb().update(workspaces).set({ bouncesEnabled: input.enabled }).where(eq(workspaces.id, ctx.workspace.id));
    await emit(ctx, input.enabled ? "bounces.enabled" : "bounces.disabled", ctx.workspace.id);
    return { enabled: input.enabled };
  });

// The browser crops and scales the image first (core/client/avatar.ts), so it arrives small.
// A leftover old file costs little and shouldn't fail the change.
export const setWorkspaceLogo = adminAction("/workspace/logo")
  .input(z.object({ image: z.base64().max(Math.ceil((MAX_AVATAR_BYTES * 4) / 3) + 4).nullable() }))
  .handler(async ({ input, ctx }) => {
    let url: string | null = null;
    if (input.image) {
      const bytes = new Uint8Array(Buffer.from(input.image, "base64"));
      const extension = sniffAvatarType(bytes);
      if (!extension) throw badRequest("Use a PNG, JPEG or WebP image");
      const file = `${crypto.randomUUID()}.${extension}`;
      await streamToStorage(logoKey(ctx.workspace.id, file), bytes as never, avatarTypes[extension]);
      url = `/api/logos/${ctx.workspace.id}/${file}`;
    }
    await getDb().update(workspaces).set({ logo: url }).where(eq(workspaces.id, ctx.workspace.id));
    await emit(ctx, url ? "workspace.logo_changed" : "workspace.logo_removed", ctx.workspace.id);
    const old = safeLogoUrl(ctx.workspace.logo)?.split("/").at(-1);
    if (old) {
      await deleteObject(logoKey(ctx.workspace.id, old)).catch((error: unknown) => {
        console.error("[logo] Couldn't delete the old file:", error);
      });
    }
    return { url };
  });

export const transferWorkspace = adminAction("/workspace/transfer")
  .input(z.object({ userId: z.string() }))
  .handler(async ({ input, ctx }) => {
    requireOwner(ctx);
    if (input.userId === ctx.user.id) throw badRequest("You already own this workspace");
    const db = getDb();
    const inWorkspace = (userId: string) =>
      and(eq(members.workspaceId, ctx.workspace.id), eq(members.userId, userId));
    const [target] = await db.select({ id: members.id }).from(members).where(inWorkspace(input.userId));
    if (!target) throw notFound("Member");
    await db.transaction(async (tx) => {
      await tx.update(members).set({ role: "admin" }).where(inWorkspace(ctx.user.id));
      await tx.update(members).set({ role: "owner" }).where(eq(members.id, target.id));
    });
    await emit(ctx, "workspace.transferred", input.userId);
    return { ok: true };
  });

export const leaveWorkspace = workspaceAction("/workspace/leave").handler(async ({ ctx }) => {
  if (ctx.role === "owner") throw badRequest("Transfer this workspace to someone else first");
  if ((await membershipCount(ctx.user.id)) <= 1) {
    throw badRequest("This is your only workspace. Create another one first");
  }
  await clearMemberAccess(ctx.workspace.id, ctx.user.id);
  await emit(ctx, "member.left", ctx.user.id);
  await getDb()
    .delete(members)
    .where(and(eq(members.workspaceId, ctx.workspace.id), eq(members.userId, ctx.user.id)));
  return { ok: true };
});

export const deleteWorkspace = adminAction("/workspace/delete").handler(async ({ ctx }) => {
  requireOwner(ctx);
  if ((await membershipCount(ctx.user.id)) <= 1) {
    throw badRequest("This is your only workspace. Create another one first");
  }
  const blocked = await getExtensions().billing?.beforeDeleteWorkspace?.(ctx.workspace.id);
  if (blocked) throw blocked;
  await destroyWorkspace(ctx.workspace.id);
  return { ok: true };
});

export const workspacesActions = {
  "/workspaces/create": createWorkspace,
  "/workspace/rename": renameWorkspace,
  "/workspace/bounces": setBounces,
  "/workspace/logo": setWorkspaceLogo,
  "/workspace/transfer": transferWorkspace,
  "/workspace/leave": leaveWorkspace,
  "/workspace/delete": deleteWorkspace,
};
