import type { CustomRequestSpec } from "./spec";
import { renderTemplate, type RenderContext, type TemplateAttachment } from "./template";

// Turns a request template into the bytes to send. Sending them is the caller's: it goes
// through the safe fetch, which checks where it goes.

export interface CustomRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: Uint8Array;
}

export interface CustomResponse {
  status: number;
  headers: Record<string, string>;
  // At most 1 MB of it.
  body: string;
}

// Sends one request. Given by the caller, so the network rules live in one place.
export type CustomHttp = (request: CustomRequest) => Promise<CustomResponse>;

const hasHeader = (headers: Record<string, string>, name: string) =>
  Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());

const isAttachmentList = (value: unknown): value is Partial<TemplateAttachment>[] =>
  Array.isArray(value) && value.length > 0 && value.every((item) => item && typeof item === "object" && "content" in item);

const fromBase64 = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const fieldText = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));

export async function buildRequest(spec: CustomRequestSpec, context: RenderContext): Promise<CustomRequest> {
  const url = renderTemplate(spec.url, { ...context, encode: encodeURIComponent });
  if (typeof url !== "string") throw new Error("The address came out empty");
  const headers = (renderTemplate(spec.headers, context) ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, fieldText(value)]));
  if (spec.auth) {
    const credentials = `${renderTemplate(spec.auth.username, context) ?? ""}:${renderTemplate(spec.auth.password, context) ?? ""}`;
    out.Authorization = `Basic ${toBase64(new TextEncoder().encode(credentials))}`;
  }
  if (!spec.body || spec.method === "GET") return { method: spec.method, url, headers: out };

  const content = renderTemplate(spec.body.content, context);
  let encoded: { bytes: Uint8Array; type?: string };
  switch (spec.body.type) {
    case "json":
      encoded = { bytes: new TextEncoder().encode(JSON.stringify(content ?? {})), type: "application/json" };
      break;
    case "text":
      encoded = { bytes: new TextEncoder().encode(typeof content === "string" ? content : fieldText(content ?? "")), type: "text/plain; charset=utf-8" };
      break;
    case "form": {
      const form = new URLSearchParams();
      for (const [key, value] of Object.entries((content ?? {}) as Record<string, unknown>)) {
        for (const item of Array.isArray(value) ? value : [value]) form.append(key, fieldText(item));
      }
      encoded = { bytes: new TextEncoder().encode(form.toString()), type: "application/x-www-form-urlencoded" };
      break;
    }
    case "multipart": {
      const form = new FormData();
      for (const [key, value] of Object.entries((content ?? {}) as Record<string, unknown>)) {
        // Attachments become file parts.
        if (isAttachmentList(value)) {
          for (const file of value) {
            const bytes = fromBase64(String(file.content ?? ""));
            form.append(key, new Blob([bytes], { type: file.contentType ?? "application/octet-stream" }), file.filename ?? "attachment");
          }
          continue;
        }
        for (const item of Array.isArray(value) ? value : [value]) form.append(key, fieldText(item));
      }
      // The boundary is chosen here, so the header comes from the encoder.
      const response = new Response(form);
      // Read before the body: Bun drops it once the body is consumed.
      const type = response.headers.get("content-type") ?? undefined;
      encoded = { bytes: new Uint8Array(await response.arrayBuffer()), type };
      if (encoded.type) {
        for (const key of Object.keys(out)) if (key.toLowerCase() === "content-type") delete out[key];
      }
      break;
    }
  }
  if (encoded.type && !hasHeader(out, "content-type")) out["Content-Type"] = encoded.type;
  return { method: spec.method, url, headers: out, body: encoded.bytes };
}

// "data.items[0].id" in a JSON answer, or "header:X-Message-Id".
export function readPath(response: { headers?: Record<string, string>; json?: unknown }, path: string): unknown {
  if (path.startsWith("header:")) {
    const name = path.slice("header:".length).toLowerCase();
    return Object.entries(response.headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
  }
  return readJsonPath(response.json, path);
}

export function readJsonPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const part of path.split(".")) {
    const [, key, indexes = ""] = part.match(/^([^[]*)((?:\[\d+\])*)$/) ?? [];
    if (key) current = current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined;
    for (const index of indexes.matchAll(/\[(\d+)\]/g)) {
      current = Array.isArray(current) ? current[Number(index[1])] : undefined;
    }
    if (current === undefined) return undefined;
  }
  return current;
}

// Hides the customer's values wherever they'd show: previews, errors, test results.
export function maskSecrets(text: string, secrets: Record<string, string>) {
  let masked = text;
  for (const [name, value] of Object.entries(secrets)) {
    if (value.length >= 4) masked = masked.split(value).join(`<${name}>`);
  }
  return masked;
}
