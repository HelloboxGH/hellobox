import { handleMailjetEvents, handleMailjetInbound } from "@hellobox/mail";

// Mailjet posts received mail to /inbound (Parse API JSON, attachments base64) and
// delivery events to /events (grouped in a list). Neither is signed: both addresses carry
// the connection's key. Mailjet retries events every 30 seconds for 24 hours.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ connectionId: string; kind: string }> },
) {
  const { connectionId, kind } = await params;
  if (kind !== "inbound" && kind !== "events") return new Response("Not found", { status: 404 });
  const key = new URL(request.url).searchParams.get("key");
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const result =
    kind === "inbound"
      ? await handleMailjetInbound(connectionId, { key, payload: payload as never })
      : await handleMailjetEvents(connectionId, { key, payload: payload as never });
  return new Response(result.status === 200 ? "OK" : null, { status: result.status });
}
