import { connectSendgrid, setSendgridReceiving } from "@hellobox/mail";
import { SendgridError } from "@hellobox/providers";
import { badRequest } from "nezt";
import { z } from "zod";
import { adminAction } from "../builder";
import { emit } from "../events";
import { fromProvider } from "./ses";

// SendGrid's own words say what to fix: a deleted key, a missing permission.
async function fromSendgrid<T>(work: () => Promise<T>) {
  return fromProvider(async () => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof SendgridError) throw badRequest(error.message);
      throw error;
    }
  });
}

export const sendgridConnect = adminAction("/connections/sendgrid/connect")
  .input(
    z.object({
      apiKey: z.string().trim().min(10, "Paste your SendGrid API key").max(200),
      // Reconnects this connection instead of adding another.
      connectionId: z.string().optional(),
    }),
  )
  .handler(async ({ input, ctx }) => {
    const result = await fromSendgrid(() => connectSendgrid({ workspaceId: ctx.workspace.id, ...input }));
    await emit(ctx, input.connectionId ? "connection.reconnected" : "connection.connected", result.connectionId, {
      provider: "sendgrid",
      region: result.region,
    });
    return result;
  });

export const sendgridReceiving = adminAction("/connections/sendgrid/receiving")
  .input(z.object({ connectionId: z.string(), domain: z.string(), on: z.boolean() }))
  .handler(async ({ input, ctx }) => {
    const result = await fromSendgrid(() => setSendgridReceiving(input.connectionId, ctx.workspace.id, input.domain, input.on));
    await emit(ctx, "domain.receiving_changed", input.connectionId, { provider: "sendgrid", domain: input.domain, on: input.on });
    return result;
  });

export const sendgridActions = {
  "/connections/sendgrid/connect": sendgridConnect,
  "/connections/sendgrid/receiving": sendgridReceiving,
};
