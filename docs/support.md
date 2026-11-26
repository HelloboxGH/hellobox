# Support in your app

Add support to your app: every message your customers send from it becomes a conversation in a
HelloBox mailbox, and you answer by email.

Your customers write in your own form. Your server passes the message to HelloBox with a secret
key. Your team answers it like any other mail, and the customer's answers, by email or from your
app, stay in the same conversation.

## Set it up

1. An admin opens **Settings → Support**, names the app and picks a shared mailbox on a domain that
   can send. Replies come from that mailbox.
2. Copy the key. It's shown once.
3. Add it to your app: copy the prompt into your AI coding tool, or use the code below.

For answers by email to arrive, the domain has to receive in HelloBox too. Settings says so until
it does.

## Answer it

Conversations are in **Support** in the sidebar, and in the mailbox, for everyone who can read that
mailbox. Beside one you see who the customer is, your metadata and its status: **Open**, **In
progress** or **Solved**. Solved archives it. A new message from the customer opens it again and
brings it back to the inbox.

AI agents connected over MCP can list support conversations and set their status, with the read
and write permissions they already have. Replying needs the send permission.

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

### Files

Send the same JSON as `multipart/form-data`, in a field named `message`, and then the files in
fields named `files`:

```bash
curl https://hellobox.app/api/support/v1/messages \
  -H "Authorization: Bearer $HELLOBOX_SUPPORT_KEY" \
  -F 'message={"user":{"id":"user_42","email":"ada@example.com"},"text":"See the screenshot.","idempotencyKey":"…"}' \
  -F 'files=@screenshot.png'
```

Up to 5 files, 10 MB each and 20 MB together. `message` has to come first. Nothing is stored
unless everything is, so if it fails, send it all again with the same `idempotencyKey`. A key can
have 2 of these requests open at once. With no file storage set up, send messages without files.

Your own host may allow less. A Vercel Function takes bodies up to 4.5 MB.

Files count toward your storage. When it's full, the request is refused and you can send the
message without files.

Programs and scripts are refused by name, such as `.exe` and `.js`. **Files aren't scanned for
malware**, here or in email. Your team sees PNG, JPEG, GIF and WebP images in the conversation,
and everything else is a download. What a file is comes from its contents, never its name.

## Show conversations in your app

For a verified customer, your server can read their conversations back and show them in your app.
Each call names the customer with `userId`, the `user.id` you sent. Anything that isn't theirs,
in this inbox, answers `404`, exactly like something missing.

| Call | |
|---|---|
| `GET /api/support/v1/conversations?userId=` | Their conversations, the newest first, 20 at a time. Pass `nextCursor` back as `cursor` for more. |
| `GET /api/support/v1/conversations/:id?userId=` | One conversation and its messages, up to the newest 200. |
| `POST /api/support/v1/conversations/:id/status` | `{ "userId": "…", "status": "solved" }`, or `"open"`. Solved archives it for your team too. |
| `GET /api/support/v1/attachments/:id?userId=` | `{ "url", "expiresAt" }`: a download link that lasts 15 minutes. |

```json
{
  "id": "…", "subject": "Export is stuck", "status": "open",
  "createdAt": "…", "lastMessageAt": "…",
  "messages": [
    { "id": "…", "from": "customer", "name": "Ada", "text": "My export…", "createdAt": "…", "attachments": [] },
    { "id": "…", "from": "team", "name": "Acme support", "text": "Fixed, try again.", "createdAt": "…",
      "attachments": [{ "id": "…", "filename": "log.txt", "contentType": "text/plain", "size": 1200 }] }
  ]
}
```

A customer sees the messages they wrote, from your app or by email, and your replies addressed to
them in To or Cc. Never notes, labels, who it's assigned to, Bcc, drafts, mail from anyone else, or
a message you sent to someone else from the conversation. Replies carry the mailbox's name, not
the teammate's. Messages are plain text, without the history an email quotes.

Unverified conversations are never readable back. A key can make 600 of these calls a minute.

`tools/support-example` is a small app that does all of this, with no dependencies.

## Or show our page

Rather than build the screens, show a HelloBox page in your app. It lists the customer's
conversations, opens one, writes, attaches files and marks a conversation solved, and checks for
replies every 15 seconds while it's visible.

Your server asks for a link for whoever is signed in:

```bash
curl https://hellobox.app/api/support/v1/sessions \
  -H "Authorization: Bearer $HELLOBOX_SUPPORT_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "user": { "id": "user_42", "email": "ada@example.com", "name": "Ada" } }'
```

```json
{ "url": "https://hellobox.app/support/s/…#hst_…", "expiresAt": "…" }
```

Open it in a frame or a new tab. A link works once, for 5 minutes, and the page it opens stays
signed in for an hour, in that page only: a reload needs a new link. Revoking the key ends it.
The page sends messages as that customer, so they're verified, and it never sends `metadata`.

To show it in a frame, add your site under **Sites that can show it** in Settings → Support, such
as `https://app.example.com`. Without one, no site can frame it. The page loads nothing from
anywhere else and runs no analytics.

In React, `tools/support-react` wraps it:

```tsx
<HelloBoxSupport getUrl={() => fetch("/api/support-link", { method: "POST" }).then((r) => r.json()).then((r) => r.url)} />
```

## Webhook

Add an address in **Settings → Support** and your server hears about verified conversations:

```json
{ "id": "…", "type": "message.created", "createdAt": "…",
  "data": { "conversationId": "…", "userId": "user_42", "messageId": "…", "from": "team" } }
```

| Type | `data` |
|---|---|
| `message.created` | `conversationId`, `userId`, `messageId`, and `from`: `customer` or `team`. Only for messages the customer can see. |
| `conversation.status_changed` | `conversationId`, `userId`, `status`. |

Events carry ids only. Read the rest with the calls above.

Each event is a `POST` with `X-HelloBox-Timestamp` and `X-HelloBox-Signature`. Check the signature:
it's `v1=` and the HMAC-SHA256, in hex, of the timestamp, a dot and the body, with your secret.
Refuse timestamps more than a few minutes old.

Answer with a `2xx`. Anything else, a redirect included, counts as a failure: the event is tried
again with growing pauses for a day, and your address gets one try per pause until it answers.
Events can arrive twice or out of order, so use `id` to skip repeats. The address has to be public
`https://`.

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
| 409 | `storage_full` | Send the message again without files. |
| 413 | `too_large` | The request or a file is too large, or there are too many. |
| 415 | `unsupported_type` | Send `application/json` or `multipart/form-data`. |
| 422 | `unsafe_file` | A file of this kind can run programs. |
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
