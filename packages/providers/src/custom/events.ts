import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { verifyBirdSignature } from "../bird";
import { readJsonPath } from "./request";
import type { CustomSpec } from "./spec";
import { EMPTY_MESSAGE, renderTemplate } from "./template";

// A custom provider's delivery webhook: checking it came from the provider, then reading
// its events with the spec's paths.

type EventsSpec = NonNullable<CustomSpec["events"]>;

export const CUSTOM_DELIVERY_TYPES = {
  delivered: "email.delivered",
  bounced: "email.bounced",
  complained: "email.complained",
  delayed: "email.delivery_delayed",
  failed: "email.failed",
} as const;

const MAX_AGE_SECONDS = 300;

const same = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

// Headers are looked up lower-cased.
export function verifyCustomEvent(
  verify: EventsSpec["verify"],
  secrets: Record<string, string>,
  input: { headers: Record<string, string>; body: Uint8Array },
  now = Date.now(),
) {
  if (!verify) return true;
  const secret = String(renderTemplate(verify.secret, { secrets, message: EMPTY_MESSAGE }) ?? "");
  if (!secret) return false;
  const header = (name: string) => input.headers[name.toLowerCase()] ?? null;

  if (verify.type === "token") {
    const given = header(verify.header);
    return given !== null && same(Buffer.from(given), Buffer.from(secret));
  }
  if (verify.type === "standard-webhooks") {
    return verifyBirdSignature(
      secret,
      {
        id: header("webhook-id") ?? header("svix-id"),
        timestamp: header("webhook-timestamp") ?? header("svix-timestamp"),
        signature: header("webhook-signature") ?? header("svix-signature"),
        body: input.body,
      },
      now,
    );
  }

  let given = header(verify.header)?.trim();
  if (!given) return false;
  if (verify.prefix) {
    if (!given.startsWith(verify.prefix)) return false;
    given = given.slice(verify.prefix.length);
  }
  const hmac = createHmac("sha256", secret);
  if (verify.timestampHeader) {
    const stamp = header(verify.timestampHeader);
    const value = Number(stamp);
    if (!stamp || !Number.isFinite(value)) return false;
    const seconds = value > 1e12 ? value / 1000 : value;
    if (Math.abs(now / 1000 - seconds) > MAX_AGE_SECONDS) return false;
    hmac.update(`${stamp}.`);
  }
  const expected = hmac.update(input.body).digest();
  const decoded = verify.encoding === "base64" ? Buffer.from(given, "base64") : Buffer.from(given.toLowerCase(), "hex");
  return same(decoded, expected);
}

export interface CustomEvent {
  type: (typeof CUSTOM_DELIVERY_TYPES)[keyof typeof CUSTOM_DELIVERY_TYPES];
  // The id the send returned, so the event finds its email.
  messageId: string;
  recipient?: string;
  reason?: string;
  // The same for the provider's retries of one event.
  eventId: string;
  payload: Record<string, unknown>;
}

const text = (value: unknown) => (typeof value === "string" || typeof value === "number" ? String(value) : undefined);

// The events in one post, a list or a single one. Event types the spec doesn't map are
// skipped, as are events without the message's id.
export function customEventsFrom(spec: EventsSpec, json: unknown): CustomEvent[] {
  const items = spec.list ? readJsonPath(json, spec.list) : json;
  const list = Array.isArray(items) ? items : [items];
  return list.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const kind = text(readJsonPath(item, spec.type));
    const status = kind === undefined ? undefined : spec.map[kind];
    const messageId = text(readJsonPath(item, spec.id))?.replace(/^<|>$/g, "");
    if (!status || !messageId) return [];
    const recipient = spec.recipient ? text(readJsonPath(item, spec.recipient))?.toLowerCase() : undefined;
    const reason = spec.reason ? text(readJsonPath(item, spec.reason)) : undefined;
    return [
      {
        type: CUSTOM_DELIVERY_TYPES[status],
        messageId,
        ...(recipient ? { recipient } : {}),
        ...(reason ? { reason: reason.slice(0, 1000) } : {}),
        eventId: `custom_${createHash("sha256").update(JSON.stringify(item)).digest("hex").slice(0, 40)}`,
        payload: item as Record<string, unknown>,
      },
    ];
  });
}
