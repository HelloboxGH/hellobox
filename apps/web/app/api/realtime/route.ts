import { getDb, members } from "@hellobox/db";
import { createSubscriber } from "@hellobox/mail";
import { realtimeChannel } from "@hellobox/queue";
import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { connection } from "next/server";
import { getAuth } from "@/core/auth";

export async function GET(request: Request) {
  // Runs per request, so the build never needs runtime env vars.
  await connection();
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) return new Response("Unauthorized", { status: 401 });
  const workspaceId = new URL(request.url).searchParams.get("workspace") ?? "";
  const [member] = await getDb()
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.userId, session.user.id), eq(members.workspaceId, workspaceId)));
  if (!member) return new Response("Forbidden", { status: 403 });

  const subscriber = createSubscriber();
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const cleanup = () => {
    if (heartbeat) clearInterval(heartbeat);
    subscriber.disconnect();
  };

  const stream = new ReadableStream({
    async start(controller) {
      subscriber.on("message", (_channel, message) => {
        controller.enqueue(encoder.encode(`data: ${message}\n\n`));
      });
      await subscriber.subscribe(realtimeChannel(workspaceId));
      heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(": ping\n\n"));
      }, 25_000);
      request.signal.addEventListener("abort", () => {
        cleanup();
        controller.close();
      });
    },
    cancel: cleanup,
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
