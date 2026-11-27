import { connectSmtp } from "@hellobox/mail";
import { SmtpAuthError, SmtpError } from "@hellobox/providers";
import { badRequest } from "nezt";
import { z } from "zod";
import { adminAction } from "../builder";
import { emit } from "../events";
import { fromProvider } from "./ses";

// Signs in to the server first, so only settings that work are saved.
export const smtpConnect = adminAction("/connections/smtp/connect")
  .input(
    z.object({
      host: z.string().trim().min(3, "Enter the server's name, such as smtp.example.com").max(253),
      port: z.coerce.number().pipe(z.union([z.literal(465), z.literal(587), z.literal(2525), z.literal(25)])),
      username: z.string().trim().min(1, "Enter the username").max(320),
      password: z.string().min(1, "Enter the password").max(1000),
      // Reconnects this connection instead of adding another.
      connectionId: z.string().optional(),
    }),
  )
  .handler(async ({ input, ctx }) => {
    const result = await fromProvider(async () => {
      try {
        return await connectSmtp({ workspaceId: ctx.workspace.id, ...input });
      } catch (error) {
        // What the server said is what to fix, wrong password included.
        if (error instanceof SmtpError || error instanceof SmtpAuthError) throw badRequest(error.message);
        throw error;
      }
    });
    await emit(ctx, input.connectionId ? "connection.reconnected" : "connection.connected", result.connectionId, {
      provider: "smtp",
      host: input.host,
    });
    return result;
  });

export const smtpActions = {
  "/connections/smtp/connect": smtpConnect,
};
