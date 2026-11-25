import { DOCS_URL } from "./links";

// What someone adding support to their app copies.

export function supportCurl(origin: string, key: string) {
  return `curl ${origin}/api/support/v1/messages \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "user": { "id": "user_42", "email": "you@example.com", "name": "Ada" },
    "text": "My first support message",
    "idempotencyKey": "first-message"
  }'`;
}

export function supportNode(origin: string) {
  return `// On your server, after checking who is signed in.
const response = await fetch("${origin}/api/support/v1/messages", {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${process.env.HELLOBOX_SUPPORT_KEY}\`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    user: { id: user.id, email: user.email, name: user.name },
    text,
    // The same one if you try again, so it's stored once.
    idempotencyKey,
  }),
});
if (!response.ok) throw new Error((await response.json()).error.message);
const { conversationId } = await response.json();`;
}

export function supportPrompt(origin: string) {
  return `Add a support form to this app. It sends messages to HelloBox, where the team answers them by email.

Look at how this app does routes, authentication, forms and styling first, and follow that.

What to build:
1. A form with a message, an optional subject and optional files. Show a clear success state, and keep what was typed if sending fails.
2. A server route it posts to. It checks the request like the app's other routes, then calls HelloBox. The key stays on the server.

The call:
POST ${origin}/api/support/v1/messages
Authorization: Bearer <HELLOBOX_SUPPORT_KEY, from an environment variable>
Content-Type: application/json
{
  "user": { "id": "...", "email": "...", "name": "..." },
  "subject": "optional, up to 200 characters",
  "text": "up to 50,000 characters",
  "idempotencyKey": "up to 200 characters",
  "metadata": { "plan": "pro" }
}

Rules:
- Take user.id, user.email and user.name from the signed-in session, never from the request body. Use an id that never changes.
- For someone who isn't signed in, leave user.id out and take user.email from the form.
- Make the idempotencyKey in the browser, one per message, and send the same one when the person tries again.
- metadata is optional: up to 20 flat values that help the team, like a plan or an app version. No secrets.
- With files, send multipart/form-data instead: that JSON in a field named "message", then each file in a field named "files". Up to 5 files, 10 MB each and 20 MB together. Stream them on if you can.
- 201 answers { "conversationId", "messageId" }, only once it's stored. Errors answer { "error": { "code", "message" } }.
- 429 has a Retry-After header in seconds. After a 5xx or no answer, send the same request again.
- Limit how often one person can send, as the app limits other forms.

Documentation: ${DOCS_URL}/support`;
}
