import { connectPostmark, listPostmarkServers, setPostmarkReceiving } from "@hellobox/mail";
import { z } from "zod";
import { adminAction } from "../builder";
import { emit } from "../events";
import { fromProvider } from "./ses";

const token = z.string().trim().min(10, "Paste your Account API token").max(200);

// The first step of connecting: checks the token and lists its servers. Nothing is saved.
export const postmarkServers = adminAction("/connections/postmark/servers")
  .input(z.object({ token }))
  .handler(async ({ input }) => ({ servers: await fromProvider(() => listPostmarkServers(input.token)) }));

export const postmarkConnect = adminAction("/connections/postmark/connect")
  .input(
    z.object({
      token,
      server: z.union([z.number().int().positive(), z.literal("new")]),
      // Reconnects this connection instead of adding another.
      connectionId: z.string().optional(),
    }),
  )
  .handler(async ({ input, ctx }) => {
    const result = await fromProvider(() =>
      connectPostmark({ workspaceId: ctx.workspace.id, token: input.token, server: input.server, connectionId: input.connectionId }),
    );
    await emit(ctx, input.connectionId ? "connection.postmark_reconnected" : "connection.postmark_connected", result.connectionId, {
      server: result.serverName,
    });
    return result;
  });

export const postmarkReceiving = adminAction("/connections/postmark/receiving")
  .input(z.object({ connectionId: z.string(), domain: z.string().nullable() }))
  .handler(async ({ input, ctx }) => {
    const result = await fromProvider(() => setPostmarkReceiving(input.connectionId, ctx.workspace.id, input.domain));
    await emit(ctx, "connection.postmark_receiving", input.connectionId, { domain: input.domain });
    return result;
  });

export const postmarkActions = {
  "/connections/postmark/servers": postmarkServers,
  "/connections/postmark/connect": postmarkConnect,
  "/connections/postmark/receiving": postmarkReceiving,
};
