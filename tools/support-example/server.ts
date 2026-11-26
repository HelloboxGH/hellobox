// A small app that shows its customers their HelloBox support conversations. No dependencies:
//
//   HELLOBOX_URL=https://hellobox.app HELLOBOX_SUPPORT_KEY=hbs_… HELLOBOX_WEBHOOK_SECRET=whsec_… \
//     bun tools/support-example/server.ts
//
// Open http://localhost:4000/?user=user_42. A real app takes the user from its own sign-in,
// never from the address bar: here it stands in for that.

import { createHmac, timingSafeEqual } from "node:crypto";

const BASE = `${process.env.HELLOBOX_URL ?? "http://localhost:3000"}/api/support/v1`;
const KEY = process.env.HELLOBOX_SUPPORT_KEY ?? "";
const SECRET = process.env.HELLOBOX_WEBHOOK_SECRET ?? "";

type Conversation = { id: string; subject: string; status: string; lastMessageAt: string };
type Message = { id: string; from: "customer" | "team"; name: string | null; text: string; createdAt: string; attachments: { id: string; filename: string }[] };

async function hellobox<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", ...init.headers },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? response.statusText);
  return body as T;
}

const escape = (text: string) =>
  text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

const page = (title: string, body: string) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title>
<style>body{font:15px/1.5 system-ui;max-width:40rem;margin:2rem auto;padding:0 1rem}.team{background:#f3f4f6}article{padding:.5rem .75rem;border-radius:.5rem;margin:.5rem 0;white-space:pre-wrap}textarea{width:100%}</style>
<h1>${escape(title)}</h1>${body}`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );

// Checks that an event came from HelloBox, and isn't an old one sent again.
function verified(request: Request, body: string) {
  const timestamp = request.headers.get("x-hellobox-timestamp") ?? "";
  const signature = request.headers.get("x-hellobox-signature") ?? "";
  const expected = `v1=${createHmac("sha256", SECRET).update(`${timestamp}.${body}`).digest("hex")}`;
  const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) < 300;
  return fresh && signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

Bun.serve({
  port: Number(process.env.PORT ?? 4000),
  async fetch(request) {
    const url = new URL(request.url);
    const user = url.searchParams.get("user") ?? "user_42";
    const userQuery = `userId=${encodeURIComponent(user)}`;

    if (url.pathname === "/webhook" && request.method === "POST") {
      const body = await request.text();
      if (!verified(request, body)) return new Response("Bad signature", { status: 401 });
      // Events can arrive twice or out of order: use the id to skip repeats.
      const event = JSON.parse(body) as { id: string; type: string; data: Record<string, string> };
      console.log(`[webhook] ${event.type}`, event.data);
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/send" && request.method === "POST") {
      const form = await request.formData();
      await hellobox("/messages", {
        method: "POST",
        body: JSON.stringify({
          user: { id: user, email: `${user}@example.com` },
          text: String(form.get("text") ?? ""),
          conversationId: form.get("conversationId") || undefined,
          idempotencyKey: String(form.get("idempotencyKey")),
        }),
      });
      return Response.redirect(`/?user=${encodeURIComponent(user)}`, 303);
    }

    const match = url.pathname.match(/^\/conversations\/([\w-]+)$/);
    if (match) {
      const conversation = await hellobox<Conversation & { messages: Message[] }>(`/conversations/${match[1]}?${userQuery}`);
      const messages = conversation.messages
        .map((message) => `<article class="${message.from}"><b>${escape(message.name ?? "You")}</b>\n${escape(message.text)}</article>`)
        .join("");
      return page(conversation.subject, `<p>${escape(conversation.status)}</p>${messages}${form(user, conversation.id)}<p><a href="/?user=${escape(encodeURIComponent(user))}">All conversations</a></p>`);
    }

    const { conversations } = await hellobox<{ conversations: Conversation[] }>(`/conversations?${userQuery}`);
    const list = conversations
      .map((item) => `<li><a href="/conversations/${escape(item.id)}?user=${escape(encodeURIComponent(user))}">${escape(item.subject)}</a> · ${escape(item.status)}</li>`)
      .join("");
    return page("Support", `<ul>${list || "<li>No conversations yet.</li>"}</ul>${form(user)}`);
  },
});

const form = (user: string, conversationId = "") =>
  `<form method="post" action="/send?user=${escape(encodeURIComponent(user))}">
<input type="hidden" name="conversationId" value="${escape(conversationId)}">
<input type="hidden" name="idempotencyKey" value="${crypto.randomUUID()}">
<textarea name="text" rows="4" required></textarea><button>Send</button></form>`;

console.log("Open http://localhost:4000/?user=user_42");
