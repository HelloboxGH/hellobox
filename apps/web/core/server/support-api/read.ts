import { customerAttachment, getCustomerConversation, listCustomerConversations, setSupportStatus } from "@hellobox/mail";
import { signedDownloadUrl } from "@hellobox/storage";
import { z } from "zod";
import { answer, answering, assertAvailable, authenticate, readBody, SupportError } from "./http";
import { parseJson } from "./schema";

// Reading a customer's conversations back. Every call names the customer, and anything that
// isn't theirs in this inbox answers exactly like something missing.

const notFound = (what: string) => new SupportError(404, "not_found", `${what} not found`);

function userIdFrom(request: Request) {
  const userId = new URL(request.url).searchParams.get("userId")?.trim();
  if (!userId || userId.length > 200 || /[\p{Cc}\p{Cs}]/u.test(userId)) {
    throw new SupportError(400, "invalid_request", "userId: Send the customer's id, as in the messages you post");
  }
  return userId;
}

const reading = (request: Request, run: (row: Awaited<ReturnType<typeof authenticate>>) => Promise<Response>) =>
  answering(async () => {
    const row = await authenticate(request, "read");
    assertAvailable(row);
    return run(row);
  });

/** GET /conversations?userId=&cursor= */
export const listConversations = (request: Request) =>
  reading(request, async (row) => {
    const cursor = new URL(request.url).searchParams.get("cursor") ?? undefined;
    const result = await listCustomerConversations(row.inbox.id, userIdFrom(request), cursor);
    if (result.status === "invalid") throw new SupportError(400, "invalid_request", "cursor: Use the nextCursor you were given");
    return answer({ conversations: result.conversations, nextCursor: result.nextCursor });
  });

/** GET /conversations/:id?userId= */
export const getConversation = (request: Request, id: string) =>
  reading(request, async (row) => {
    const conversation = await getCustomerConversation(row.inbox.id, userIdFrom(request), id);
    if (!conversation) throw notFound("Conversation");
    return answer(conversation);
  });

const statusSchema = z.object({ userId: z.string().trim().min(1).max(200), status: z.enum(["solved", "open"]) });

/** POST /conversations/:id/status, with { userId, status }. Solved archives it for the team too. */
export const setConversationStatus = (request: Request, id: string) =>
  answering(async () => {
    const row = await authenticate(request);
    assertAvailable(row);
    const { userId, status } = parseJson(statusSchema, await readBody(request, 4096));
    const conversation = await getCustomerConversation(row.inbox.id, userId, id);
    if (!conversation) throw notFound("Conversation");
    await setSupportStatus([id], status);
    return answer({ id, status });
  });

const LINK_MINUTES = 15;

/** GET /attachments/:id?userId=: a download link that lasts a few minutes. */
export const getAttachment = (request: Request, id: string) =>
  reading(request, async (row) => {
    const file = await customerAttachment(row.inbox.id, userIdFrom(request), id);
    if (!file) throw notFound("Attachment");
    return answer({
      url: await signedDownloadUrl(file.storageKey, file.filename, file.contentType),
      expiresAt: new Date(Date.now() + LINK_MINUTES * 60_000).toISOString(),
    });
  });
