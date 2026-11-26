import { earlierResult, type PostResult, postSupportMessage, type SupportInbox } from "@hellobox/mail";
import { answer, answering, assertAvailable, authenticate, contentType, limitUser, MAX_JSON_BYTES, readBody, retryAfter, SupportError } from "./http";
import { parseMessage } from "./schema";
import { withUploadSlot } from "./slots";
import { assertUploadLength, receiveWithFiles } from "./upload";


type Post = typeof postSupportMessage;

export function messageAnswer(result: PostResult) {
  switch (result.status) {
    case "stored":
    case "repeated":
      return answer({ conversationId: result.conversationId, messageId: result.messageId }, 201);
    case "key-reused":
      throw new SupportError(409, "idempotency_key_reused", "This idempotencyKey was already used for a different message");
    case "not-found":
      throw new SupportError(404, "not_found", "Conversation not found");
    case "limit":
      throw new SupportError(
        429,
        "monthly_limit",
        `This workspace's plan takes ${result.max} support messages a month`,
        retryAfter(result.resetAt.getTime()),
      );
  }
}

async function postJson(row: SupportInbox, request: Request, post: Post) {
  const message = parseMessage(await readBody(request, MAX_JSON_BYTES));
  const earlier = await earlierResult(row, message);
  if (earlier) return messageAnswer(earlier);
  await limitUser(row.inbox.id, message.user);
  return messageAnswer(await post(row, message, "api"));
}

/** POST /api/support/v1/messages. Answers with success only once the message is stored. */
export const postMessage = (request: Request, post: Post = postSupportMessage) =>
  answering(async () => {
    const row = await authenticate(request);
    assertAvailable(row);
    switch (contentType(request)) {
      case "application/json":
        return postJson(row, request, post);
      case "multipart/form-data":
        assertUploadLength(request);
        return withUploadSlot(row.keyId, async () => messageAnswer(await receiveWithFiles(row, request, {
          parse: parseMessage,
          limit: (message) => limitUser(row.inbox.id, message.user),
          post: (message, upload) => post(row, message, "api", undefined, upload),
        })));
      default:
        throw new SupportError(415, "unsupported_type", "Send application/json, or multipart/form-data with files");
    }
  });
