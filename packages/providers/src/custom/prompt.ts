import { FORM_EXAMPLE, JSON_EXAMPLE } from "./examples";
import { customSpecJsonSchema } from "./spec";

// What people give their AI, with their provider's API docs pasted under it. The answer is
// pasted back into HelloBox, which checks it like any other spec.
export function customSpecPrompt() {
  return `You're writing a JSON "spec" that tells HelloBox how to send an email through an email provider's HTTP API. Read the provider's API documentation at the end, then answer with the spec only: one JSON object, no comments, no explanation.

## Rules

- Never put a real API key, password or secret in the spec. Wherever one goes, write a placeholder in capitals between angle brackets, like <API_KEY>, <ACCOUNT_ID> or <WEBHOOK_SECRET>. The person types the values into HelloBox afterwards, where they're stored encrypted. Placeholders work in the address, headers, body and "auth".
- The parts of each email are placeholders in double braces, like {{subject}}. A string that is only one placeholder takes the value's own type (a list stays a list); inside longer text it's inserted as text. Empty values are left out of the request.
- Use "auth": { "type": "basic", "username": ..., "password": ... } for HTTP Basic authentication instead of writing an Authorization header.
- "body.type" is "json", "form" (URL-encoded), "multipart" (attachments become file parts) or "text".
- Set "send.response.id" to where the provider's message id is in its answer: a dot path like "data.id" or "messages[0].id", or "header:X-Message-Id" for a response header.
- Keep the email's threading: pass {{headers | map}} (or the shape the API wants) when the API accepts custom headers, since they carry Message-ID, In-Reply-To and References.
- If the documentation lists the account's sending domains, add "domains". If it describes delivery webhooks, add "events", mapping the provider's event names to delivered, bounced, complained, delayed or failed, with "id" pointing at the same message id the send returns. Otherwise set them to null.
- Only use what the documentation shows. Don't guess endpoints or fields.

## Message fields and formats (after "|")

- to, cc, bcc, replyTo: default a list of "Name <address>"; "csv" (one string); "emails" (list of bare addresses); "first" or "first email" (one); "objects email name" (list of objects, with your own key names, like "objects address display")
- from: default "Name <address>"; "email"; "name"; "object email name"
- subject, html, text, idempotencyKey: as they are
- messageId: default "<id@host>"; "bare" (without the brackets)
- headers, tags: "map" ({ "Name": "value" }); "list name value" ([{ "name": ..., "value": ... }], with your own key names)
- attachments: "objects" with the parts filename, contentType, content (base64) and contentId, each renamed as part=key, like "objects filename=name content=data contentType=type"
- mime: the whole message as RFC 5322 text; "base64"

## Example: a JSON API

${JSON.stringify(JSON_EXAMPLE, null, 2)}

## Example: a form API with Basic authentication

${JSON.stringify(FORM_EXAMPLE, null, 2)}

## JSON Schema of the spec

${JSON.stringify(customSpecJsonSchema())}

## The provider's API documentation

(Paste the documentation for sending an email here, and for domains and webhooks if you want them.)
`;
}

// The AI's answer, which may be wrapped in a code block or have words around it.
export function specFromAnswer(answer: string): unknown {
  const fenced = answer.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = fenced?.[1] ?? answer;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("The answer has no JSON object in it");
  return JSON.parse(text.slice(start, end + 1));
}
