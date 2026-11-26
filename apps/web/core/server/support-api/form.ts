import { setting } from "@hellobox/config";
import { earlierResult, findSupportForm, type PostResult, postSupportMessage, type SupportInbox, type SupportMessage } from "@hellobox/mail";
import { clientIp } from "nezt/middlewares";
import { z } from "zod";
import { answer, answering, assertAvailable, contentType, limit, limitUser, MAX_JSON_BYTES, readBody, SupportError } from "./http";
import { messageAnswer } from "./messages";
import { parseJson, parseMessage, userSchema } from "./schema";
import { withUploadSlot } from "./slots";
import { assertUploadLength, receiveWithFiles } from "./upload";

// The public form. Its key is public, so all it can do is start a new, unverified
// conversation: never continue one, never read one. What looks like a bot is kept in Spam
// with the reasons, never dropped. The Origin check keeps other sites' pages out; anything
// else can send any Origin, so the limits and Turnstile are what hold.

type Post = typeof postSupportMessage;
export type Verify = (token: string, ip: string | null) => Promise<boolean | null>;

export const FORM_LIMITS = { ip: 5, form: 30, workspace: 60 };

export const SPAM = {
  trap: "Filled in a field people can't see",
  bot: "Didn't pass the bot check",
};

const formSchema = z.object({
  email: userSchema.shape.email,
  name: userSchema.shape.name,
  text: z.string(),
  subject: z.string().optional(),
  idempotencyKey: z.string(),
  // The hidden field. People leave it empty.
  website: z.string().max(1000).optional(),
  turnstileToken: z.string().max(4096).optional(),
});

type FormBody = z.infer<typeof formSchema>;

/** Cloudflare's answer for a Turnstile token: null when it couldn't be asked. */
export const verifyTurnstile: Verify = async (token, ip) => {
  const secret = setting("TURNSTILE_SECRET_KEY");
  if (!secret) return null;
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: new URLSearchParams({ secret, response: token, ...(ip ? { remoteip: ip } : {}) }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    return ((await response.json()) as { success?: boolean }).success === true;
  } catch {
    return null;
  }
};

// An outage at Cloudflare lets the message in, as a scanner outage does for email.
async function suspicion(body: FormBody, ip: string | null, verify: Verify) {
  const reasons: string[] = [];
  if (body.website?.trim()) reasons.push(SPAM.trap);
  if (setting("TURNSTILE_SECRET_KEY")) {
    const passed = body.turnstileToken ? await verify(body.turnstileToken, ip) : false;
    if (passed === false) reasons.push(SPAM.bot);
  }
  return reasons;
}

// Only checks the form's own fields; the message is checked as any other.
function parseForm(text: string): { body: FormBody; message: SupportMessage } {
  const body = parseJson(formSchema, text);
  const message = parseMessage(JSON.stringify({
    user: { email: body.email, ...(body.name ? { name: body.name } : {}) },
    text: body.text,
    subject: body.subject,
    idempotencyKey: body.idempotencyKey,
  }));
  return { body, message };
}

/** Where browsers may send from: this site, and the inbox's allowed sites. */
export function originAllowed(request: Request, row: SupportInbox) {
  const origin = request.headers.get("origin");
  if (!origin) return { allowed: true, origin: null };
  let own: string | null = null;
  try {
    own = new URL(setting("APP_URL") ?? "").origin;
  } catch {
    own = null;
  }
  const allowed = origin === own || row.inbox.allowedOrigins.includes(origin);
  return { allowed, origin: allowed ? origin : null };
}

const cors = (origin: string | null): Record<string, string> =>
  origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : { Vary: "Origin" };

function withHeaders(response: Response, headers: Record<string, string>) {
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}

async function form(request: Request, key: string) {
  const row = await findSupportForm(key);
  if (!row) throw new SupportError(404, "not_found", "This form doesn't exist or was turned off");
  return row;
}

// Each counts every try, before anything is read: what a bot sends costs it the same.
async function limits(row: SupportInbox, ip: string | null) {
  if (ip) await limit(`form-ip:${ip}`, FORM_LIMITS.ip, "Too many messages. Try again in a minute");
  await limit(`form:${row.inbox.id}`, FORM_LIMITS.form, "This form is getting too many messages. Try again in a minute");
  await limit(`form-workspace:${row.inbox.workspaceId}`, FORM_LIMITS.workspace, "This form is getting too many messages. Try again in a minute");
}

// Says nothing about the conversation: whoever sent it can't read it back.
function received(result: PostResult) {
  const response = messageAnswer(result);
  return response.status === 201 ? answer({ received: true }, 201) : response;
}

async function send(row: SupportInbox, request: Request, ip: string | null, post: Post, verify: Verify) {
  const limited = (message: SupportMessage) => limitUser(row.inbox.id, message.user);
  switch (contentType(request)) {
    case "application/json": {
      const { body, message } = parseForm(await readBody(request, MAX_JSON_BYTES));
      const earlier = await earlierResult(row, message);
      if (earlier) return received(earlier);
      await limited(message);
      return received(await post(row, message, "form", undefined, undefined, await suspicion(body, ip, verify)));
    }
    case "multipart/form-data": {
      assertUploadLength(request);
      let body: FormBody | undefined;
      return withUploadSlot(row.inbox.id, async () => received(await receiveWithFiles(row, request, {
        parse: (text) => {
          const parsed = parseForm(text);
          body = parsed.body;
          return parsed.message;
        },
        limit: limited,
        refuse: (file) => (file.contentType.startsWith("image/") ? undefined : `${file.filename} isn't an image. This form takes PNG, JPEG, GIF and WebP images`),
        post: async (message, upload) => post(row, message, "form", undefined, upload, await suspicion(body!, ip, verify)),
      })), "support-form");
    }
    default:
      throw new SupportError(415, "unsupported_type", "Send application/json, or multipart/form-data with images");
  }
}

/** POST /api/support/form/:key. Answers only once the message is stored. */
export async function postForm(request: Request, key: string, post: Post = postSupportMessage, verify: Verify = verifyTurnstile) {
  let headers: Record<string, string> = { Vary: "Origin" };
  const response = await answering(async () => {
    const row = await form(request, key);
    const { allowed, origin } = originAllowed(request, row);
    headers = cors(origin);
    if (!allowed) throw new SupportError(403, "forbidden_origin", "This site can't send to this form. Add it under Sites in HelloBox");
    const ip = clientIp(request);
    await limits(row, ip);
    assertAvailable(row);
    return send(row, request, ip, post, verify);
  });
  return withHeaders(response, headers);
}

/** GET /api/support/form/:key: what the form page shows. */
export const formDetails = (request: Request, key: string) =>
  answering(async () => {
    const row = await form(request, key);
    return answer({ name: row.inbox.name, turnstileSiteKey: setting("TURNSTILE_SITE_KEY") ?? null });
  });

/** The browser's check before a cross-site POST. */
export async function formPreflight(request: Request, key: string) {
  const row = await findSupportForm(key);
  const { allowed, origin } = row ? originAllowed(request, row) : { allowed: false, origin: null };
  if (!allowed || !origin) return new Response(null, { status: 403, headers: { Vary: "Origin" } });
  return new Response(null, {
    status: 204,
    headers: {
      ...cors(origin),
      "Access-Control-Allow-Methods": "POST",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "600",
    },
  });
}
