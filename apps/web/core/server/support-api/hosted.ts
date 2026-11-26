import {
  customerAttachment, earlierResult, exchangeSupportSession, findSupportSession, getCustomerConversation,
  listCustomerConversations, postSupportMessage, setSupportStatus, type SupportMessage,
} from "@hellobox/mail";
import { signedDownloadUrl } from "@hellobox/storage";
import { z } from "zod";
import { answer, answering, assertAvailable, contentType, limit, limitUser, MAX_JSON_BYTES, readBody, SupportError } from "./http";
import { messageAnswer } from "./messages";
import { parseJson, parseMessage } from "./schema";
import { withUploadSlot } from "./slots";
import { assertUploadLength, receiveWithFiles } from "./upload";

// What the hosted page calls, with the session it got for one customer. The customer is
// always the session's: nothing in a request can name another.

type Session = NonNullable<Awaited<ReturnType<typeof findSupportSession>>>;
type Post = typeof postSupportMessage;

const READS = 120;
const notFound = (what: string) => new SupportError(404, "not_found", `${what} not found`);
const expired = () => new SupportError(401, "invalid_key", "This page has expired. Open support again from the app");

async function session(request: Request) {
  const [scheme, token, ...rest] = (request.headers.get("authorization") ?? "").trim().split(/\s+/);
  const found = scheme?.toLowerCase() === "bearer" && token && !rest.length ? await findSupportSession(token) : null;
  if (!found) throw expired();
  assertAvailable(found);
  return found;
}

const exchangeSchema = z.object({ inboxId: z.string().min(1).max(100), token: z.string().min(1).max(100) });

/** POST session: the link's one-time token for a session. */
async function exchange(request: Request) {
  const { inboxId, token } = parseJson(exchangeSchema, await readBody(request, 1024));
  const exchanged = await exchangeSupportSession(token, inboxId);
  if (!exchanged) throw new SupportError(401, "invalid_key", "This link was used or has expired. Open support again from the app");
  const found = await findSupportSession(exchanged.session);
  if (!found) throw expired();
  return answer({
    session: exchanged.session,
    expiresAt: exchanged.expiresAt.toISOString(),
    inbox: found.inbox.name,
    user: { email: found.user.email, name: found.user.name ?? null },
  });
}

// The customer types the message; who they are comes from the session. Metadata is the
// developer's to send, never the customer's.
function parseHosted(row: Session) {
  return (text: string): SupportMessage => {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new SupportError(400, "invalid_request", "The body isn't valid JSON");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new SupportError(400, "invalid_request", "Send a JSON object");
    const { user: _user, metadata: _metadata, ...rest } = value as Record<string, unknown>;
    return parseMessage(JSON.stringify({ ...rest, user: row.user }));
  };
}

async function send(row: Session, request: Request, post: Post) {
  const parse = parseHosted(row);
  const limited = (message: SupportMessage) => limitUser(row.inbox.id, message.user);
  switch (contentType(request)) {
    case "application/json": {
      const message = parse(await readBody(request, MAX_JSON_BYTES));
      const earlier = await earlierResult(row, message);
      if (earlier) return messageAnswer(earlier);
      await limited(message);
      return messageAnswer(await post(row, message, "hosted"));
    }
    case "multipart/form-data":
      assertUploadLength(request);
      return withUploadSlot(row.keyId, async () => messageAnswer(await receiveWithFiles(row, request, {
        parse,
        limit: limited,
        post: (message, upload) => post(row, message, "hosted", undefined, upload),
      })));
    default:
      throw new SupportError(415, "unsupported_type", "Send application/json, or multipart/form-data with files");
  }
}

const statusSchema = z.object({ status: z.enum(["solved", "open"]) });

/** Everything under /api/support/hosted/. */
export const hosted = (request: Request, path: string[], post: Post = postSupportMessage) =>
  answering(async () => {
    const [first, id, last] = path;
    if (request.method === "POST" && first === "session" && path.length === 1) return exchange(request);
    const row = await session(request);
    const userId = row.user.id;
    if (request.method === "POST" && first === "messages" && path.length === 1) return send(row, request, post);
    await limit(`hosted:${row.keyId}:${userId}`, READS, `Too many requests. Try again in a minute`);
    if (request.method === "GET" && first === "conversations" && path.length === 1) {
      const result = await listCustomerConversations(row.inbox.id, userId, new URL(request.url).searchParams.get("cursor") ?? undefined);
      if (result.status === "invalid") throw new SupportError(400, "invalid_request", "cursor: Use the nextCursor you were given");
      return answer({ conversations: result.conversations, nextCursor: result.nextCursor });
    }
    if (first === "conversations" && id && path.length === 2 && request.method === "GET") {
      const conversation = await getCustomerConversation(row.inbox.id, userId, id);
      if (!conversation) throw notFound("Conversation");
      return answer(conversation);
    }
    if (first === "conversations" && id && last === "status" && path.length === 3 && request.method === "POST") {
      const { status } = parseJson(statusSchema, await readBody(request, 1024));
      if (!(await getCustomerConversation(row.inbox.id, userId, id))) throw notFound("Conversation");
      await setSupportStatus([id], status);
      return answer({ id, status });
    }
    if (first === "attachments" && id && path.length === 2 && request.method === "GET") {
      const file = await customerAttachment(row.inbox.id, userId, id);
      if (!file) throw notFound("Attachment");
      return answer({ url: await signedDownloadUrl(file.storageKey, file.filename, file.contentType) });
    }
    throw new SupportError(404, "not_found", "No such call");
  });
