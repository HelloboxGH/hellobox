import { z } from "zod";

// A custom provider: any sending service, described by the customer in one JSON spec.
// Plan: docs/plans/CUSTOM_PROVIDER.md. This file has no Node imports, so the settings
// screen validates specs with it too.
//
// Two kinds of placeholder, in any string of the spec:
// - <NAME>: the customer's own values (keys, account ids), sealed at rest.
// - {{field | format}}: the message, filled at send time.

export const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;

// The message fields a request can use.
export const MESSAGE_FIELDS = [
  "from",
  "to",
  "cc",
  "bcc",
  "replyTo",
  "subject",
  "html",
  "text",
  "headers",
  "attachments",
  "tags",
  "idempotencyKey",
  "messageId",
  "mime",
] as const;
export type MessageField = (typeof MESSAGE_FIELDS)[number];

// One pattern for both, so a value put in by one is never read as the other.
export const PLACEHOLDER = /<([A-Z][A-Z0-9_]*)>|\{\{\s*([^{}]+?)\s*\}\}/g;

const method = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const headers = z.record(z.string().min(1).max(200), z.string().max(4000)).default({});

const body = z.object({
  type: z.enum(["json", "form", "multipart", "text"]),
  // JSON for json; an object of fields for form and multipart; a string for text.
  content: z.unknown(),
});

const request = z.object({
  method,
  url: z.string().min(1).max(2000),
  headers,
  // Sent as an Authorization: Basic header, encoded after the values are put in.
  auth: z.object({ type: z.literal("basic"), username: z.string().max(1000), password: z.string().max(1000) }).optional(),
  body: body.optional(),
});

// Where to read a value in a JSON answer: "data.items[0].id". "header:X-Message-Id"
// reads a response header instead.
export const valuePath = z
  .string()
  .min(1)
  .max(200)
  .regex(/^(header:[A-Za-z0-9-]+|[A-Za-z0-9_$-]+(\[\d+\])*(\.[A-Za-z0-9_$-]+(\[\d+\])*)*)$/, "Use a path like data.items[0].id, or header:X-Message-Id");

export const DELIVERY_STATUSES = ["delivered", "bounced", "complained", "delayed", "failed"] as const;

const verify = z.discriminatedUnion("type", [
  z.object({
    // HMAC-SHA256 of the raw body, or of "timestamp.body" when a timestamp header is named.
    type: z.literal("hmac-sha256"),
    header: z.string().min(1).max(100),
    secret: z.string().min(1).max(200),
    encoding: z.enum(["hex", "base64"]).default("hex"),
    prefix: z.string().max(40).optional(),
    timestampHeader: z.string().min(1).max(100).optional(),
  }),
  // Svix-style: webhook-id, webhook-timestamp and webhook-signature (or svix-*).
  z.object({ type: z.literal("standard-webhooks"), secret: z.string().min(1).max(200) }),
  // A header that must equal a secret.
  z.object({ type: z.literal("token"), header: z.string().min(1).max(100), secret: z.string().min(1).max(200) }),
]);

export const customSpec = z.object({
  version: z.literal(1),
  name: z.string().trim().min(1).max(60),
  send: request.extend({
    response: z.object({ id: valuePath.optional() }).optional(),
  }),
  // Lists the account's domains. Without it, the customer types them.
  domains: request
    .extend({
      list: valuePath,
      name: valuePath,
      verified: z.object({ path: valuePath, equals: z.union([z.string(), z.number(), z.boolean()]) }).optional(),
    })
    .nullable()
    .optional(),
  // The delivery webhook. Without it, sent mail shows Sent, never Delivered.
  // The webhook's address always carries a key of ours. verify adds the provider's own
  // signature check on top, when it signs.
  events: z
    .object({
      verify: verify.optional(),
      list: valuePath.optional(),
      type: valuePath,
      map: z.record(z.string().min(1).max(100), z.enum(DELIVERY_STATUSES)),
      id: valuePath,
      recipient: valuePath.optional(),
      reason: valuePath.optional(),
    })
    .nullable()
    .optional(),
});

export type CustomSpec = z.infer<typeof customSpec>;
export type CustomRequestSpec = z.infer<typeof request>;

// Every string in a value, deep.
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      strings(item, out);
    }
  }
  return out;
}

// The <NAME> values a spec needs, in order of first use.
export function secretNames(spec: unknown): string[] {
  const names = new Set<string>();
  for (const text of strings(spec)) {
    for (const match of text.matchAll(PLACEHOLDER)) if (match[1]) names.add(match[1]);
  }
  return [...names];
}

export interface Placeholder {
  field: string;
  format: string[];
}

export function parsePlaceholder(inner: string): Placeholder {
  const [field = "", ...rest] = inner.split("|");
  return { field: field.trim(), format: rest.join("|").trim().split(/\s+/).filter(Boolean) };
}

// The message placeholders a request uses.
export function messagePlaceholders(value: unknown): Placeholder[] {
  const found: Placeholder[] = [];
  for (const text of strings(value)) {
    for (const match of text.matchAll(PLACEHOLDER)) if (match[2]) found.push(parsePlaceholder(match[2]));
  }
  return found;
}

// The host part of a URL template, as written: "<REGION>.api.acme.com" for
// "https://<REGION>.api.acme.com/v1/send". Null when it doesn't start with a scheme.
export function templateHost(url: string): string | null {
  const match = url.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i);
  if (!match) return null;
  // Without user info or port.
  return match[1]!.replace(/^.*@/, "").replace(/:[^:\]]*$/, "");
}

// A <NAME> in a host must fill whole DNS labels, so its value can't move the request to
// another domain ("evil.com#" in https://<REGION>.acme.com).
export const HOST_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;

export type SpecCheck = { ok: true; spec: CustomSpec; secrets: string[] } | { ok: false; problems: string[] };

// Checks a spec as typed or pasted: its shape, then that every placeholder names a
// message field and every <NAME> is spelled right. Formats are checked by rendering it.
export function checkSpec(input: unknown): SpecCheck {
  let value = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch (error) {
      return { ok: false, problems: [`That isn't valid JSON: ${(error as Error).message}`] };
    }
  }
  const parsed = customSpec.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((issue) => `${issue.path.join(".") || "spec"}: ${issue.message}`),
    };
  }
  const problems: string[] = [];
  for (const { field } of messagePlaceholders(parsed.data.send)) {
    if (!(MESSAGE_FIELDS as readonly string[]).includes(field)) problems.push(`{{${field}}} isn't a message field. Use one of ${MESSAGE_FIELDS.join(", ")}.`);
  }
  for (const request of [parsed.data.send, parsed.data.domains]) {
    if (!request) continue;
    const host = templateHost(request.url);
    if (host === null) continue;
    if (/\{\{/.test(host)) problems.push(`${request.url}: the address's host can't use a message field`);
    for (const label of host.split(".")) {
      if (/<[A-Z][A-Z0-9_]*>/.test(label) && !/^<[A-Z][A-Z0-9_]*>$/.test(label)) {
        problems.push(`${request.url}: a <NAME> in the host has to be a whole part between dots, like https://<REGION>.api.example.com`);
      }
    }
  }
  for (const part of [parsed.data.domains, parsed.data.events]) {
    for (const { field } of messagePlaceholders(part ?? null)) problems.push(`{{${field}}} only works in the send request`);
  }
  for (const text of strings(parsed.data)) {
    for (const match of text.matchAll(/<([A-Za-z][A-Za-z0-9_]*)>/g)) {
      if (!SECRET_NAME.test(match[1]!) && /key|secret|token|id|password/i.test(match[1]!)) {
        problems.push(`<${match[1]}> needs capitals, like <${match[1]!.toUpperCase()}>`);
      }
    }
  }
  if (problems.length) return { ok: false, problems: [...new Set(problems)] };
  return { ok: true, spec: parsed.data, secrets: secretNames(parsed.data) };
}

// The JSON Schema, for the prompt people give their AI.
export const customSpecJsonSchema = () => z.toJSONSchema(customSpec, { io: "input" });
