import { findSupportKey, type SupportInbox, supportInboxProblem, touchSupportKey } from "@hellobox/mail";
import { redisRateLimitStore } from "../redis-rate-limit";

// The support API's answers, and the checks every call starts with. Kept apart from the
// action system, which reads whole bodies before anything looks at them.

export type SupportErrorCode =
  | "invalid_key"
  | "invalid_request"
  | "not_found"
  | "idempotency_key_reused"
  | "unavailable"
  | "rate_limited"
  | "monthly_limit"
  | "too_large"
  | "unsupported_type";

export class SupportError extends Error {
  constructor(
    readonly status: number,
    readonly code: SupportErrorCode,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

const noStore = { "Cache-Control": "no-store" };

export const answer = (body: unknown, status = 200) => Response.json(body, { status, headers: noStore });

/** Turns what a call throws into its JSON answer. Anything unexpected stays ours. */
export async function answering(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof SupportError) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status, headers: { ...noStore, ...error.headers } },
      );
    }
    console.error("[support-api]", error);
    return Response.json(
      { error: { code: "server_error", message: "Something went wrong. Send the same request again." } },
      { status: 500, headers: noStore },
    );
  }
}

const MINUTE_MS = 60_000;
export const KEY_LIMIT = 60;
export const USER_LIMIT = 10;

export const retryAfter = (at: number) => ({ "Retry-After": String(Math.max(1, Math.ceil((at - Date.now()) / 1000))) });

async function limit(key: string, max: number, message: string) {
  const { count, resetAt } = await redisRateLimitStore.increment(`support:${key}`, MINUTE_MS);
  if (count > max) throw new SupportError(429, "rate_limited", message, retryAfter(resetAt));
}

/** The key's inbox, checked and counted before any of the body is read. */
export async function authenticate(request: Request): Promise<SupportInbox & { keyId: string }> {
  const [scheme, token, ...rest] = (request.headers.get("authorization") ?? "").trim().split(/\s+/);
  const row = scheme?.toLowerCase() === "bearer" && token && !rest.length ? await findSupportKey(token) : null;
  if (!row) throw new SupportError(401, "invalid_key", "Send a valid key as Authorization: Bearer hbs_…", { "WWW-Authenticate": "Bearer" });
  await limit(`key:${row.keyId}`, KEY_LIMIT, `A key can send ${KEY_LIMIT} requests a minute`);
  await touchSupportKey(row.keyId);
  return row;
}

export function assertAvailable(row: SupportInbox) {
  const problem = supportInboxProblem(row);
  if (problem) throw new SupportError(409, "unavailable", problem);
}

// By the developer's own id, or by address when they didn't give one.
export const limitUser = (inboxId: string, user: { id?: string; email: string }) =>
  limit(`user:${inboxId}:${user.id ? `id:${user.id}` : `email:${user.email}`}`, USER_LIMIT, `A customer can send ${USER_LIMIT} messages a minute`);

const READ_TIMEOUT_MS = 20_000;

/** Reads a small body, counting what really arrives: Content-Length can say anything. */
export async function readBody(request: Request, maxBytes: number, timeoutMs = READ_TIMEOUT_MS) {
  const tooLarge = () => new SupportError(413, "too_large", `This request is too large. The most is ${Math.floor(maxBytes / 1024)} KB`);
  assertLength(request, maxBytes, tooLarge);
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new SupportError(408, "invalid_request", "The request took too long to arrive")), timeoutMs);
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw tooLarge();
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const whole = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    whole.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(whole);
}

export function assertLength(request: Request, maxBytes: number, tooLarge: () => SupportError) {
  const header = request.headers.get("content-length");
  if (header === null) return;
  if (!/^\d+$/.test(header)) throw new SupportError(400, "invalid_request", "Content-Length must be a number");
  if (Number(header) > maxBytes) throw tooLarge();
}

export const contentType = (request: Request) => (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
