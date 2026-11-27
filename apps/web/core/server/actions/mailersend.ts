import { connectMailersend, setMailersendReceiving } from "@hellobox/mail";
import { MailersendError } from "@hellobox/providers";
import { badRequest } from "nezt";
import { z } from "zod";
import { adminAction } from "../builder";
import { emit } from "../events";
import { fromProvider } from "./ses";

// MailerSend's own words say what to fix: a deleted token, a domain it won't take.
async function fromMailersend<T>(work: () => Promise<T>) {
  return fromProvider(async () => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof MailersendError) throw badRequest(error.message);
      throw error;
    }
  });
}

export const mailersendConnect = adminAction("/connections/mailersend/connect")
  .input(
    z.object({
      apiKey: z.string().trim().min(10, "Paste your MailerSend API token").max(200),
      // Reconnects this connection instead of adding another.
      connectionId: z.string().optional(),
    }),
  )
  .handler(async ({ input, ctx }) => {
    const result = await fromMailersend(() => connectMailersend({ workspaceId: ctx.workspace.id, ...input }));
    await emit(ctx, input.connectionId ? "connection.reconnected" : "connection.connected", result.connectionId, {
      provider: "mailersend",
    });
    return result;
  });

export const mailersendReceiving = adminAction("/connections/mailersend/receiving")
  .input(z.object({ connectionId: z.string(), domain: z.string(), on: z.boolean() }))
  .handler(async ({ input, ctx }) => {
    const result = await fromMailersend(() => setMailersendReceiving(input.connectionId, ctx.workspace.id, input.domain, input.on));
    await emit(ctx, "domain.receiving_changed", input.connectionId, { provider: "mailersend", domain: input.domain, on: input.on });
    return result;
  });

export const mailersendActions = {
  "/connections/mailersend/connect": mailersendConnect,
  "/connections/mailersend/receiving": mailersendReceiving,
};
