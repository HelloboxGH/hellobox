import { setting } from "@hellobox/config";
import { createSupportSession } from "@hellobox/mail";
import { z } from "zod";
import { answer, answering, assertAvailable, authenticate, readBody } from "./http";
import { parseJson, userSchema } from "./schema";

const sessionSchema = z.object({
  // The hosted page is for someone signed in to the app, so the id is required.
  user: userSchema.required({ id: true }),
});

export const hostedPageUrl = (inboxId: string, token: string) =>
  `${(setting("APP_URL") ?? "").replace(/\/$/, "")}/support/s/${inboxId}#${token}`;

/** POST /api/support/v1/sessions: a link to the hosted page for one customer, valid once for 5 minutes. */
export const postSession = (request: Request) =>
  answering(async () => {
    const row = await authenticate(request);
    assertAvailable(row);
    const { user } = parseJson(sessionSchema, await readBody(request, 4096));
    const { token, expiresAt } = await createSupportSession(row, { ...user, name: user.name || undefined });
    return answer({ url: hostedPageUrl(row.inbox.id, token), expiresAt: expiresAt.toISOString() }, 201);
  });
