import { handlePostmarkEvent, handlePostmarkInbound } from "@hellobox/mail";
import type { PostmarkEvent, PostmarkInbound } from "@hellobox/providers";

// Postmark posts new mail to /inbound and delivery events to /events, with basic auth.
// It retries anything but a 200, so 204 isn't used here. Errors thrown while storing
// mail become a 500, which Postmark retries for about ten hours.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ connectionId: string; kind: string }> },
) {
  const { connectionId, kind } = await params;
  if (kind !== "inbound" && kind !== "events") return new Response("Not found", { status: 404 });
  let body: unknown;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const authorization = request.headers.get("authorization");
  const { status } =
    kind === "inbound"
      ? await handlePostmarkInbound(connectionId, authorization, body as PostmarkInbound)
      : await handlePostmarkEvent(connectionId, authorization, request.headers.get("x-pm-webhook-trace-id"), body as PostmarkEvent);
  return new Response(status === 200 ? "OK" : null, { status });
}
