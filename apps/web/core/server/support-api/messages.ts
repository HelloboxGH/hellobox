import { earlierResult, type PostResult, postSupportMessage } from "@hellobox/mail";
import { answer, answering, assertAvailable, authenticate, contentType, limitUser, readBody, retryAfter, SupportError } from "./http";
import { parseMessage } from "./schema";

// 50,000 characters of text, escaped in the worst way, with room for the rest.
const MAX_JSON_BYTES = 512 * 1024;

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

/** POST /api/support/v1/messages. Answers with success only once the message is stored. */
export const postMessage = (request: Request, post: Post = postSupportMessage) =>
  answering(async () => {
    const row = await authenticate(request);
    assertAvailable(row);
    if (contentType(request) !== "application/json") {
      throw new SupportError(415, "unsupported_type", "Send JSON, with Content-Type: application/json");
    }
    const message = parseMessage(await readBody(request, MAX_JSON_BYTES));
    const earlier = await earlierResult(row, message);
    if (earlier) return messageAnswer(earlier);
    await limitUser(row.inbox.id, message.user);
    return messageAnswer(await post(row, message, "api"));
  });
