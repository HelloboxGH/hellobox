import { connectBrevo, setBrevoReceiving } from "@hellobox/mail";
import { BrevoError } from "@hellobox/providers";
import { badRequest } from "nezt";
import { z } from "zod";
import { adminAction } from "../builder";
import { emit } from "../events";
import { fromProvider } from "./ses";

// Brevo's own words say what to fix: a deleted key, a domain it won't take.
async function fromBrevo<T>(work: () => Promise<T>) {
  return fromProvider(async () => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof BrevoError) throw badRequest(error.message);
      throw error;
    }
  });
}

export const brevoConnect = adminAction("/connections/brevo/connect")
  .input(
    z.object({
      apiKey: z.string().trim().min(10, "Paste your Brevo API key").max(200),
      // Reconnects this connection instead of adding another.
      connectionId: z.string().optional(),
    }),
  )
  .handler(async ({ input, ctx }) => {
    const result = await fromBrevo(() => connectBrevo({ workspaceId: ctx.workspace.id, ...input }));
    await emit(ctx, input.connectionId ? "connection.reconnected" : "connection.connected", result.connectionId, {
      provider: "brevo",
    });
    return result;
  });

export const brevoReceiving = adminAction("/connections/brevo/receiving")
  .input(z.object({ connectionId: z.string(), domain: z.string(), on: z.boolean() }))
  .handler(async ({ input, ctx }) => {
    const result = await fromBrevo(() => setBrevoReceiving(input.connectionId, ctx.workspace.id, input.domain, input.on));
    await emit(ctx, "domain.receiving_changed", input.connectionId, { provider: "brevo", domain: input.domain, on: input.on });
    return result;
  });

export const brevoActions = {
  "/connections/brevo/connect": brevoConnect,
  "/connections/brevo/receiving": brevoReceiving,
};
