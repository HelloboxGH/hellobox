# Support in your app

Add support to your app: every message your customers send from it becomes a conversation in a
HelloBox mailbox, and you answer by email.

Your customers write in your own form. Your server passes the message to HelloBox with a secret
key. Your team answers it like any other mail, and the customer's answers, by email or from your
app, stay in the same conversation.

You need a shared mailbox on a domain that can send. For answers by email to arrive, the domain
has to receive in HelloBox too.

## Send a message

Keep the key on your server, never in a browser or an app people install.

```bash
curl https://hellobox.app/api/support/v1/messages \
  -H "Authorization: Bearer $HELLOBOX_SUPPORT_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "user": { "id": "user_42", "email": "ada@example.com", "name": "Ada" },
    "subject": "Export is stuck",
    "text": "My export has been running for an hour.",
    "idempotencyKey": "b1f0c2d4-…",
    "metadata": { "plan": "pro" }
  }'
```

Running HelloBox yourself? Use your own address instead of hellobox.app.

| Field | |
|---|---|
| `user.email` | Required. Where replies go. |
| `user.id` | Your own id for the customer, when they're signed in to your app. It's what makes them verified. |
| `user.name` | Optional. |
| `text` | Required. Plain text, up to 50,000 characters. |
| `subject` | Optional, up to 200 characters. Without one, the first line is used. Ignored when you continue a conversation. |
| `conversationId` | Continues a conversation of this customer's. Needs `user.id`. |
| `idempotencyKey` | Required, up to 200 characters. A new one for each message. |
| `metadata` | Optional details for your team: up to 20 flat keys and 4 KB. It replaces what the conversation had. |

The answer is `201` with the ids, and only once the message is stored:

```json
{ "conversationId": "…", "messageId": "…" }
```

Keep `conversationId` with the customer's conversation, and send it with their next message.

### Retrying

If you didn't get an answer, send the same request again with the same `idempotencyKey`. You get
the first result, and the message is stored once. The same key with different content answers
`409`.

## Who is verified

Whoever your server says, with `user.id`. Only send it for someone signed in to your app, and use
an id that never changes or passes to someone else.

Without `user.id`, nobody vouched for the address. The message is always a new conversation, and
your team sees that the address isn't confirmed.

When a verified customer's email changes, send the new one with their next message. Replies in all
their conversations go there from then on.

## Errors

Errors are JSON, with a sentence that says what to do:

```json
{ "error": { "code": "invalid_request", "message": "user.email: Invalid email address" } }
```

| Status | Code | Why |
|---|---|---|
| 400 | `invalid_request` | A field is missing or wrong. |
| 401 | `invalid_key` | The key is missing, wrong or revoked. |
| 404 | `not_found` | No such conversation, or it isn't this customer's. |
| 408 | `invalid_request` | The request took too long to arrive. |
| 409 | `idempotency_key_reused` | The key was used for a different message. |
| 409 | `unavailable` | The workspace is suspended, the mailbox is gone, or its domain can't send. |
| 413 | `too_large` | The request is too large. |
| 415 | `unsupported_type` | Send `application/json`. |
| 429 | `rate_limited` | Too many requests. `Retry-After` says when to try again, in seconds. |
| 429 | `monthly_limit` | The plan's messages for the month are used. |
| 500 | `server_error` | Something went wrong. Send the same request again. |

A key can make 60 requests a minute, and each customer can send 10 messages a minute.

## Answers by email

Your customers get your reply as an email from the mailbox, and can answer it there. Every answer
is in the conversation for your team. It also counts as the customer's own when it comes from
their address and passes DMARC, or both SPF and DKIM.

HelloBox sends nothing by itself: no confirmation and no "we got your message". Only your team's
replies go out.
