import { connectMailjet, setMailjetReceiving } from "@hellobox/mail";
import { MailjetError } from "@hellobox/providers";
import { badRequest } from "nezt";
import { z } from "zod";
import { adminAction } from "../builder";
import { emit } from "../events";
import { fromProvider } from "./ses";

// Mailjet's own words say what to fix: wrong keys, a plan without the Parse API.
async function fromMailjet<T>(work: () => Promise<T>) {
  return fromProvider(async () => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof MailjetError) throw badRequest(error.message);
      throw error;
    }
  });
}

export const mailjetConnect = adminAction("/connections/mailjet/connect")
  .input(
    z.object({
      apiKey: z.string().trim().min(10, "Paste your Mailjet API key").max(200),
      secretKey: z.string().trim().min(10, "Paste your Mailjet secret key").max(200),
      // Reconnects this connection instead of adding another.
      connectionId: z.string().optional(),
    }),
  )
  .handler(async ({ input, ctx }) => {
    const result = await fromMailjet(() => connectMailjet({ workspaceId: ctx.workspace.id, ...input }));
    await emit(ctx, input.connectionId ? "connection.reconnected" : "connection.connected", result.connectionId, {
      provider: "mailjet",
    });
    return result;
  });

export const mailjetReceiving = adminAction("/connections/mailjet/receiving")
  .input(z.object({ connectionId: z.string(), domain: z.string(), on: z.boolean() }))
  .handler(async ({ input, ctx }) => {
    const result = await fromMailjet(() => setMailjetReceiving(input.connectionId, ctx.workspace.id, input.domain, input.on));
    await emit(ctx, "domain.receiving_changed", input.connectionId, { provider: "mailjet", domain: input.domain, on: input.on });
    return result;
  });

export const mailjetActions = {
  "/connections/mailjet/connect": mailjetConnect,
  "/connections/mailjet/receiving": mailjetReceiving,
};
