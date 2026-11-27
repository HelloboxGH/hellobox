import type { CustomRequestSpec, CustomSpec } from "./spec";

// Turns a curl command from a provider's docs into a spec's send request. Runs in the
// browser and on the server. Options it doesn't know are refused by name, never ignored,
// since an ignored one could change what the request means.

export class CurlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CurlError";
  }
}

// Splits like a POSIX shell: single quotes, double quotes with \ escapes, $'…' strings,
// and backslash line continuations.
export function shellWords(command: string): string[] {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let i = 0;
  const text = command.replace(/\\\r?\n/g, " ");
  while (i < text.length) {
    const char = text[i]!;
    if (/\s/.test(char)) {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
      i++;
      continue;
    }
    inWord = true;
    if (char === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) throw new CurlError("A ' quote isn't closed");
      word += text.slice(i + 1, end);
      i = end + 1;
    } else if (char === "$" && text[i + 1] === "'") {
      i += 2;
      while (i < text.length && text[i] !== "'") {
        if (text[i] === "\\" && i + 1 < text.length) {
          const next = text[i + 1]!;
          word += ({ n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"' } as Record<string, string>)[next] ?? next;
          i += 2;
        } else word += text[i++];
      }
      if (text[i] !== "'") throw new CurlError("A $' quote isn't closed");
      i++;
    } else if (char === '"') {
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < text.length && '"\\$`'.includes(text[i + 1]!)) {
          word += text[i + 1];
          i += 2;
        } else word += text[i++];
      }
      if (text[i] !== '"') throw new CurlError('A " quote isn\'t closed');
      i++;
    } else if (char === "\\" && i + 1 < text.length) {
      word += text[i + 1];
      i += 2;
    } else {
      word += char;
      i++;
    }
  }
  if (inWord) words.push(word);
  return words;
}

// Options that only change what curl prints.
const HARMLESS = new Set(["-s", "--silent", "-S", "--show-error", "-v", "--verbose", "-i", "--include", "--compressed", "-f", "--fail", "--fail-with-body", "-g", "--globoff"]);
const SHORT_HARMLESS = new Set(["s", "S", "v", "i", "f", "g"]);

const TAKES_VALUE: Record<string, string> = {
  "-X": "method",
  "--request": "method",
  "-H": "header",
  "--header": "header",
  "-u": "user",
  "--user": "user",
  "-d": "data",
  "--data": "data",
  "--data-raw": "data",
  "--data-binary": "data",
  "--data-ascii": "data",
  "--data-urlencode": "urlencode",
  "--json": "json",
  "-F": "form",
  "--form": "form",
  "--form-string": "formString",
  "--url": "url",
  "-A": "agent",
  "--user-agent": "agent",
};

interface Parsed {
  method?: string;
  url?: string;
  headers: [string, string][];
  user?: string;
  data: string[];
  urlencode: string[];
  json?: string;
  form: [string, string, boolean][];
}

function parseWords(words: string[]): Parsed {
  const parsed: Parsed = { headers: [], data: [], urlencode: [], form: [] };
  if (words[0] === "curl") words = words.slice(1);
  else if (words.length && !words[0]!.startsWith("-") && !/^https?:/i.test(words[0]!)) {
    throw new CurlError("Paste a command that starts with curl");
  }
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (!word.startsWith("-") || word === "-") {
      if (parsed.url) throw new CurlError(`Two addresses: ${parsed.url} and ${word}. Keep one.`);
      parsed.url = word;
      continue;
    }
    if (HARMLESS.has(word)) continue;
    let name = word;
    let value: string | undefined;
    if (word.startsWith("--") && word.includes("=")) {
      name = word.slice(0, word.indexOf("="));
      value = word.slice(word.indexOf("=") + 1);
    } else if (!word.startsWith("--") && word.length > 2) {
      // -XPOST, -H'…', or bundled flags like -sS.
      if (TAKES_VALUE[word.slice(0, 2)]) {
        name = word.slice(0, 2);
        value = word.slice(2);
      } else if ([...word.slice(1)].every((flag) => SHORT_HARMLESS.has(flag))) continue;
    }
    const kind = TAKES_VALUE[name];
    if (!kind) {
      if (name === "-L" || name === "--location") throw new CurlError(`${name} isn't supported: HelloBox never follows redirects. Use the final address.`);
      throw new CurlError(`${name} isn't supported`);
    }
    if (value === undefined) {
      value = words[++i];
      if (value === undefined) throw new CurlError(`${name} needs a value`);
    }
    switch (kind) {
      case "method":
        parsed.method = value.toUpperCase();
        break;
      case "header": {
        const colon = value.indexOf(":");
        if (colon <= 0) throw new CurlError(`"${value}" isn't a header. Use Name: value.`);
        parsed.headers.push([value.slice(0, colon).trim(), value.slice(colon + 1).trim()]);
        break;
      }
      case "user":
        parsed.user = value;
        break;
      case "data":
        if (value.startsWith("@")) throw new CurlError(`${name} ${value} reads a file, which isn't supported. Paste the body itself.`);
        parsed.data.push(value);
        break;
      case "urlencode":
        parsed.urlencode.push(value);
        break;
      case "json":
        if (value.startsWith("@")) throw new CurlError(`--json ${value} reads a file, which isn't supported. Paste the body itself.`);
        parsed.json = (parsed.json ?? "") + value;
        break;
      case "form":
      case "formString": {
        const equals = value.indexOf("=");
        if (equals <= 0) throw new CurlError(`"${value}" isn't a form field. Use name=value.`);
        parsed.form.push([value.slice(0, equals), value.slice(equals + 1), kind === "form"]);
        break;
      }
      case "url":
        if (parsed.url) throw new CurlError(`Two addresses: ${parsed.url} and ${value}. Keep one.`);
        parsed.url = value;
        break;
      case "agent":
        parsed.headers.push(["User-Agent", value]);
        break;
    }
  }
  return parsed;
}

const addField = (fields: Record<string, unknown>, key: string, value: unknown) => {
  const existing = fields[key];
  if (existing === undefined) fields[key] = value;
  else fields[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
};

function formFields(text: string) {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of new URLSearchParams(text)) addField(fields, key, value);
  return fields;
}

const isJsonType = (type: string | undefined) => Boolean(type && /[/+]json\b/i.test(type));

// The send request a curl command describes.
export function parseCurl(command: string): CustomRequestSpec {
  const parsed = parseWords(shellWords(command.trim()));
  if (!parsed.url) throw new CurlError("The command has no address");
  const url = /^[a-z]+:\/\//i.test(parsed.url) ? parsed.url : `https://${parsed.url}`;
  if (!/^https:\/\//i.test(url)) throw new CurlError("Use an https:// address");

  const headers: Record<string, string> = {};
  for (const [name, value] of parsed.headers) headers[name] = value;
  const typeKey = Object.keys(headers).find((key) => key.toLowerCase() === "content-type");
  const contentType = typeKey ? headers[typeKey] : undefined;

  const kinds = [parsed.json !== undefined, parsed.data.length + parsed.urlencode.length > 0, parsed.form.length > 0].filter(Boolean);
  if (kinds.length > 1) throw new CurlError("The command mixes body options (--json, -d, -F). Use one kind.");

  let body: CustomRequestSpec["body"];
  if (parsed.json !== undefined || (parsed.data.length && isJsonType(contentType))) {
    const text = parsed.json ?? parsed.data.join("&");
    try {
      body = { type: "json", content: JSON.parse(text) };
    } catch {
      throw new CurlError("The body says it's JSON, but it isn't valid JSON");
    }
    if (parsed.json !== undefined && !Object.keys(headers).some((key) => key.toLowerCase() === "accept")) headers.Accept = "application/json";
  } else if (parsed.data.length || parsed.urlencode.length) {
    if (contentType && !/x-www-form-urlencoded/i.test(contentType)) {
      body = { type: "text", content: parsed.data.join("&") };
    } else {
      const fields = formFields(parsed.data.join("&"));
      for (const item of parsed.urlencode) {
        const equals = item.indexOf("=");
        if (equals <= 0) throw new CurlError(`--data-urlencode ${item} needs name=value`);
        addField(fields, item.slice(0, equals), item.slice(equals + 1));
      }
      body = { type: "form", content: fields };
    }
  } else if (parsed.form.length) {
    const fields: Record<string, unknown> = {};
    for (const [key, value, special] of parsed.form) {
      // A file from disk: the message's attachments go there.
      if (special && value.startsWith("@")) {
        fields[key] = "{{attachments}}";
        continue;
      }
      if (special && value.startsWith("<")) throw new CurlError(`-F ${key}=${value} reads a file, which isn't supported`);
      addField(fields, key, special ? value.replace(/;type=[^;]*$/, "") : value);
    }
    body = { type: "multipart", content: fields };
  }

  // The body sets its own type, multipart's with its boundary.
  if (typeKey && body && (body.type === "multipart" || (body.type === "form" && /x-www-form-urlencoded/i.test(contentType ?? "")))) {
    delete headers[typeKey];
  }
  if (typeKey && body?.type === "json" && /^application\/json\b/i.test(contentType ?? "")) delete headers[typeKey];

  const method = parsed.method ?? (body ? "POST" : "GET");
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new CurlError(`${method} isn't supported. Use GET, POST, PUT, PATCH or DELETE.`);

  let auth: CustomRequestSpec["auth"];
  if (parsed.user !== undefined) {
    const colon = parsed.user.indexOf(":");
    auth = { type: "basic", username: colon < 0 ? parsed.user : parsed.user.slice(0, colon), password: colon < 0 ? "" : parsed.user.slice(colon + 1) };
  }

  return { method: method as CustomRequestSpec["method"], url, headers, ...(auth ? { auth } : {}), ...(body ? { body } : {}) };
}

// A whole spec from a curl command, named after the API's host.
export function specFromCurl(command: string): CustomSpec {
  const send = parseCurl(command);
  const host = new URL(send.url.replace(/<[A-Z][A-Z0-9_]*>/g, "x")).hostname;
  const parts = host.split(".").filter((part) => !["api", "www", "x", "v1", "v2", "v3"].includes(part));
  const base = parts.length > 1 ? parts[parts.length - 2]! : (parts[0] ?? "Custom");
  return { version: 1, name: base.charAt(0).toUpperCase() + base.slice(1), send };
}

// Values that look like a real key, so one pasted by mistake can be swapped for a <NAME>
// before it's saved in the spec.
const KEY_PATTERNS = [
  /\bre_[A-Za-z0-9_]{16,}/,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{12,}/,
  /\bxkeysib-[A-Za-z0-9-]{20,}/,
  /\bmlsn\.[A-Za-z0-9]{20,}/,
  /\bbk_[a-z0-9]+_[A-Za-z0-9]{16,}/,
  /\bkey-[a-f0-9]{24,}/,
  /\b[A-Fa-f0-9]{32,}\b/,
  /\b[A-Za-z0-9_\-+]{32,}={0,2}/,
];

export interface LikelyKey {
  // Where it is, like "headers.Authorization".
  where: string;
  value: string;
}

const isLikelyKey = (text: string) => {
  const outside = text.replace(/<[A-Z][A-Z0-9_]*>|\{\{[^{}]*\}\}/g, " ");
  for (const pattern of KEY_PATTERNS) {
    const found = outside.match(pattern)?.[0];
    // Long random runs need letters and digits both, so a long word isn't flagged.
    if (found && (pattern !== KEY_PATTERNS.at(-1) || (/[0-9]/.test(found) && /[A-Za-z]/.test(found)))) return found;
  }
  return null;
};

export function likelyKeys(value: unknown, where = ""): LikelyKey[] {
  if (typeof value === "string") {
    const found = isLikelyKey(value);
    return found ? [{ where: where || "value", value: found }] : [];
  }
  if (Array.isArray(value)) return value.flatMap((item, index) => likelyKeys(item, `${where}[${index}]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => likelyKeys(item, where ? `${where}.${key}` : key));
  }
  return [];
}

// Puts <NAME> wherever the value was.
export function replaceValue<T>(value: T, find: string, replacement: string): T {
  if (typeof value === "string") return value.split(find).join(replacement) as T;
  if (Array.isArray(value)) return value.map((item) => replaceValue(item, find, replacement)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceValue(item, find, replacement)])) as T;
  }
  return value;
}
