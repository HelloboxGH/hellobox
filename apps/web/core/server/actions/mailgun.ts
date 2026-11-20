import { connectMailgun, setMailgunReceiving } from "@hellobox/mail";
import { z } from "zod";
import { adminAction } from "../builder";
import { emit } from "../events";
import { fromProvider } from "./ses";

// Finds the region from where the domains are. When it can't tell, it answers
// needsRegion and saves nothing, and the person picks one.
export const mailgunConnect = adminAction("/connections/mailgun/connect")
  .input(
    z.object({
      apiKey: z.string().trim().min(10, "Paste your Mailgun API key").max(200),
      signingKey: z.string().trim().min(10, "Paste your HTTP webhook signing key").max(200),
      region: z.enum(["us", "eu"]).optional(),
      // Reconnects this connection instead of adding another.
      connectionId: z.string().optional(),
    }),
  )
  .handler(async ({ input, ctx }) => {
    const result = await fromProvider(() => connectMailgun({ workspaceId: ctx.workspace.id, ...input }));
    if (!result.needsRegion) {
      await emit(ctx, input.connectionId ? "connection.mailgun_reconnected" : "connection.mailgun_connected", result.connectionId, {
        region: result.region,
      });
    }
    return result;
  });

export const mailgunReceiving = adminAction("/connections/mailgun/receiving")
  .input(z.object({ connectionId: z.string(), domain: z.string(), on: z.boolean() }))
  .handler(async ({ input, ctx }) => {
    const result = await fromProvider(() => setMailgunReceiving(input.connectionId, ctx.workspace.id, input.domain, input.on));
    await emit(ctx, "connection.mailgun_receiving", input.connectionId, { domain: input.domain, on: input.on });
    return result;
  });

export const mailgunActions = {
  "/connections/mailgun/connect": mailgunConnect,
  "/connections/mailgun/receiving": mailgunReceiving,
};
