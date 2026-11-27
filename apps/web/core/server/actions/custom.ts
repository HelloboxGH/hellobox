import { connectCustom, customDetails, setCustomAppearance, testCustomSend } from "@hellobox/mail";
import { CustomAuthError, CustomError } from "@hellobox/providers";
import { badRequest } from "nezt";
import { z } from "zod";
import { adminAction } from "../builder";
import { emit } from "../events";
import { logoImage, removeStoredLogo, storeLogo } from "../logo-store";
import { fromProvider } from "./ses";

const appearance = z.object({
  description: z.string().trim().max(280).nullable().optional(),
  // A new logo in base64, or null to remove it.
  logo: logoImage.nullable().optional(),
});

async function saveAppearance(workspaceId: string, connectionId: string, look: z.infer<typeof appearance>) {
  const logo = look.logo ? await storeLogo(workspaceId, look.logo) : look.logo;
  const { replacedLogo } = await fromProvider(() => setCustomAppearance(connectionId, workspaceId, { description: look.description, logo }));
  await removeStoredLogo(workspaceId, replacedLogo);
}

// Saves a custom provider's spec and seals its <NAME> values. Problems with the spec come
// back as a list to fix.
export const customConnect = adminAction("/connections/custom/connect")
  .input(
    z.object({
      // Pasted JSON, or the object the editor built. Checked by checkSpec.
      spec: z.union([z.string().max(100_000), z.record(z.string(), z.unknown())]),
      // Values for each <NAME>. Empty ones keep what was saved, on reconnect.
      values: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/).max(64), z.string().max(4000)).default({}),
      connectionId: z.string().optional(),
      // How it looks on its card. Left out, what was saved stays; null removes it.
      appearance: appearance.optional(),
    }),
  )
  .handler(async ({ input, ctx }) => {
    const { appearance: look, ...connect } = input;
    const result = await fromProvider(async () => {
      try {
        return await connectCustom({ workspaceId: ctx.workspace.id, ...connect });
      } catch (error) {
        if (error instanceof CustomError || error instanceof CustomAuthError) throw badRequest(error.message);
        throw error;
      }
    });
    if (look) await saveAppearance(ctx.workspace.id, result.connectionId, look);
    await emit(ctx, input.connectionId ? "connection.reconnected" : "connection.connected", result.connectionId, {
      provider: "custom",
    });
    return result;
  });

// Sends one email to the signed-in person with a spec that isn't saved yet.
export const customTest = adminAction("/connections/custom/test")
  .input(
    z.object({
      spec: z.union([z.string().max(100_000), z.record(z.string(), z.unknown())]),
      values: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/).max(64), z.string().max(4000)).default({}),
      connectionId: z.string().optional(),
      from: z.email("Enter the address to send from, on one of your domains").max(320),
    }),
  )
  .handler(async ({ input, ctx }) =>
    fromProvider(async () => {
      try {
        return await testCustomSend({ workspaceId: ctx.workspace.id, ...input, to: ctx.user.email });
      } catch (error) {
        if (error instanceof CustomError || error instanceof CustomAuthError) throw badRequest(error.message);
        throw error;
      }
    }),
  );

// The saved spec, to edit it, and the address for delivery events. Admins only: the
// address carries the webhook's key.
export const customDetailsAction = adminAction("/connections/custom/details")
  .input(z.object({ connectionId: z.string() }))
  .handler(async ({ input, ctx }) => fromProvider(() => customDetails(input.connectionId, ctx.workspace.id)));

// Changes only the description and logo.
export const customAppearance = adminAction("/connections/custom/appearance")
  .input(z.object({ connectionId: z.string() }).extend(appearance.shape))
  .handler(async ({ input, ctx }) => {
    const { connectionId, ...look } = input;
    await saveAppearance(ctx.workspace.id, connectionId, look);
    return { ok: true };
  });

export const customActions = {
  "/connections/custom/appearance": customAppearance,
  "/connections/custom/details": customDetailsAction,
  "/connections/custom/connect": customConnect,
  "/connections/custom/test": customTest,
};
