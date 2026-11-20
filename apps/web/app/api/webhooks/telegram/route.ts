import { timingSafeEqual } from "node:crypto";
import { handleTelegramUpdate, notificationEnv } from "@hellobox/mail";
import { connection } from "next/server";

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Telegram calls this with every message to the bot. The secret header proves it's Telegram;
// it's set along with the webhook (setTelegramWebhook, when the worker starts).
export async function POST(request: Request) {
  await connection();
  const secret = notificationEnv().telegram?.secret;
  const given = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!secret || !same(given, secret)) return new Response("Unauthorized", { status: 401 });
  try {
    await handleTelegramUpdate(await request.json());
  } catch (error) {
    // Answering 200 anyway stops Telegram retrying an update we can't use.
    console.error("[telegram] update failed:", error);
  }
  return Response.json({ ok: true });
}
