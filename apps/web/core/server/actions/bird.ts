import { connectBird, setBirdReceiving } from "@hellobox/mail";
import { BirdError } from "@hellobox/providers";
import { badRequest } from "nezt";
import { z } from "zod";
import { adminAction } from "../builder";
import { emit } from "../events";
import { fromProvider } from "./ses";

// Bird's own words say what to fix: a revoked key, a missing permission, a domain it won't take.
async function fromBird<T>(work: () => Promise<T>) {
  return fromProvider(async () => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof BirdError) throw badRequest(error.message);
      throw error;
    }
  });
}

export const birdConnect = adminAction("/connections/bird/connect")
  .input(
    z.object({
      apiKey: z.string().trim().min(10, "Paste your Bird access key").max(300),
      // Reconnects this connection instead of adding another.
      connectionId: z.string().optional(),
    }),
  )
  .handler(async ({ input, ctx }) => {
    const result = await fromBird(() => connectBird({ workspaceId: ctx.workspace.id, ...input }));
    await emit(ctx, input.connectionId ? "connection.reconnected" : "connection.connected", result.connectionId, {
      provider: "bird",
      region: result.region,
    });
    return result;
  });

export const birdReceiving = adminAction("/connections/bird/receiving")
  .input(z.object({ connectionId: z.string(), domain: z.string(), on: z.boolean() }))
  .handler(async ({ input, ctx }) => {
    const result = await fromBird(() => setBirdReceiving(input.connectionId, ctx.workspace.id, input.domain, input.on));
    await emit(ctx, "domain.receiving_changed", input.connectionId, { provider: "bird", domain: input.domain, on: input.on });
    return result;
  });

export const birdActions = {
  "/connections/bird/connect": birdConnect,
  "/connections/bird/receiving": birdReceiving,
};
