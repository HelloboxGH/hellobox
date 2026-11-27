import { parsePlaceholder, PLACEHOLDER, type Placeholder } from "./spec";

// Fills a custom provider's request with the customer's values and the message.

export interface TemplateAttachment {
  filename: string;
  contentType: string;
  // Base64.
  content: string;
  contentId?: string;
}

export interface TemplateMessage {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string[];
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
  attachments: TemplateAttachment[];
  tags: Record<string, string>;
  idempotencyKey: string;
  messageId: string;
  // The whole message as RFC 5322 text. Only built when the spec uses it.
  mime: string;
}

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

const ADDRESS_LISTS = new Set(["to", "cc", "bcc", "replyTo"]);

function splitAddress(value: string) {
  const match = value.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (!match) return { email: value.trim(), name: "" };
  return { email: match[2]!.trim(), name: match[1]!.replace(/^"|"$/g, "").trim() };
}

// key=part pairs, like "filename=name content=data": the part goes under the key on the right.
function renames(args: string[], parts: readonly string[], field: string) {
  return args.map((arg) => {
    const [part, key = part] = arg.split("=");
    if (!part || !parts.includes(part)) throw new TemplateError(`{{${field}}} has no part "${part}". Use ${parts.join(", ")}.`);
    return { part, key };
  });
}

const base64 = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

// One placeholder's value, in the format asked for.
export function formatField(message: TemplateMessage, { field, format }: Placeholder): unknown {
  const [kind, ...args] = format;
  const unknown = () => new TemplateError(`{{${field} | ${format.join(" ")}}}: "${kind}" isn't a format for ${field}`);

  if (ADDRESS_LISTS.has(field)) {
    const list = message[field as "to"];
    if (!kind) return list;
    if (kind === "csv") return list.join(", ");
    if (kind === "emails") return list.map((value) => splitAddress(value).email);
    if (kind === "first") {
      const first = list[0];
      if (!first) return "";
      if (args[0] === "email") return splitAddress(first).email;
      return first;
    }
    if (kind === "objects") {
      const [emailKey = "email", nameKey = "name"] = args;
      return list.map((value) => {
        const { email, name } = splitAddress(value);
        return { [emailKey]: email, ...(name ? { [nameKey]: name } : {}) };
      });
    }
    throw unknown();
  }

  if (field === "from") {
    const { email, name } = splitAddress(message.from);
    if (!kind) return message.from;
    if (kind === "email") return email;
    if (kind === "name") return name;
    if (kind === "object") {
      const [emailKey = "email", nameKey = "name"] = args;
      return { [emailKey]: email, ...(name ? { [nameKey]: name } : {}) };
    }
    throw unknown();
  }

  if (field === "headers" || field === "tags") {
    const map = message[field];
    if (!kind || kind === "map") return map;
    if (kind === "list") {
      const [nameKey = "name", valueKey = "value"] = args;
      return Object.entries(map).map(([name, value]) => ({ [nameKey]: name, [valueKey]: value }));
    }
    throw unknown();
  }

  if (field === "attachments") {
    const parts = ["filename", "contentType", "content", "contentId"] as const;
    if (kind && kind !== "objects") throw unknown();
    const keys = (args.length ? renames(args, parts, field) : parts.map((part) => ({ part, key: part }))) as {
      part: (typeof parts)[number];
      key: string;
    }[];
    return message.attachments.map((file) =>
      Object.fromEntries(keys.flatMap(({ part, key }) => (file[part] === undefined ? [] : [[key, file[part]]]))),
    );
  }

  if (field === "mime") {
    if (!kind) return message.mime;
    if (kind === "base64") return base64(message.mime);
    throw unknown();
  }

  if (field === "messageId") {
    if (!kind) return message.messageId;
    if (kind === "bare") return message.messageId.replace(/^<|>$/g, "");
    throw unknown();
  }

  if (kind) throw unknown();
  const value = message[field as "subject"];
  if (value === undefined) throw new TemplateError(`{{${field}}} isn't a message field`);
  return value;
}

const isEmpty = (value: unknown) =>
  value === undefined ||
  value === null ||
  value === "" ||
  (Array.isArray(value) && value.length === 0) ||
  (typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0);

const asText = (value: unknown) =>
  typeof value === "string" ? value : Array.isArray(value) && value.every((item) => typeof item === "string") ? value.join(", ") : JSON.stringify(value);

export interface RenderContext {
  secrets: Record<string, string>;
  message: TemplateMessage;
  // Applied to whatever is put into a string, for URLs.
  encode?: (value: string) => string;
}

const OMIT = Symbol("omit");

function renderString(text: string, context: RenderContext): unknown {
  // Only a message placeholder: the value keeps its type (a list stays a list).
  const whole = text.match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
  if (whole) {
    const value = formatField(context.message, parsePlaceholder(whole[1]!));
    if (isEmpty(value)) return OMIT;
    return typeof value === "string" && context.encode ? context.encode(value) : value;
  }
  // Otherwise inserted as text, in one pass, so nothing put in is read again.
  return text.replace(PLACEHOLDER, (_match, secret: string | undefined, inner: string | undefined) => {
    let value: string;
    if (secret) {
      const found = context.secrets[secret];
      if (found === undefined) throw new TemplateError(`<${secret}> has no value`);
      value = found;
    } else {
      value = asText(formatField(context.message, parsePlaceholder(inner!)));
    }
    return context.encode ? context.encode(value) : value;
  });
}

function renderValue(value: unknown, context: RenderContext): unknown {
  if (typeof value === "string") return renderString(value, context);
  if (Array.isArray(value)) return value.map((item) => renderValue(item, context)).filter((item) => item !== OMIT);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const renderedKey = renderString(key, { ...context, encode: undefined });
      const rendered = renderValue(item, context);
      if (rendered !== OMIT && typeof renderedKey === "string") out[renderedKey] = rendered;
    }
    return out;
  }
  return value;
}

// Fills a template. Empty message values are left out of the request, so an empty cc
// list isn't sent.
export function renderTemplate(value: unknown, context: RenderContext): unknown {
  const rendered = renderValue(value, context);
  return rendered === OMIT ? undefined : rendered;
}

// A sample message, for checking formats and previewing a request.
export const SAMPLE_MESSAGE: TemplateMessage = {
  from: "Ada Lovelace <ada@example.com>",
  to: ["Grace Hopper <grace@example.org>"],
  cc: [],
  bcc: [],
  replyTo: ["support@example.com"],
  subject: "Re: Your question",
  html: "<p>Thanks for writing.</p>",
  text: "Thanks for writing.",
  headers: { "Message-ID": "<sample@hellobox.app>", "In-Reply-To": "<previous@example.org>", References: "<previous@example.org>" },
  attachments: [{ filename: "notes.txt", contentType: "text/plain", content: "aGVsbG8=" }],
  tags: { thread: "sample" },
  idempotencyKey: "sample-key",
  messageId: "<sample@hellobox.app>",
  mime: "From: ada@example.com\r\nTo: grace@example.org\r\nSubject: Re: Your question\r\n\r\nThanks for writing.",
};

// No message, for requests and checks that don't send one.
export const EMPTY_MESSAGE: TemplateMessage = {
  from: "",
  to: [],
  cc: [],
  bcc: [],
  replyTo: [],
  subject: "",
  html: "",
  text: "",
  headers: {},
  attachments: [],
  tags: {},
  idempotencyKey: "",
  messageId: "",
  mime: "",
};
