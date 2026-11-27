import { handleMailersendEvents, handleMailersendInbound } from "@hellobox/mail";

// MailerSend posts received mail to /inbound (an inbound route's webhook forward, checked
// by the key in the address) and delivery events to /events, signed with the domain's
// webhook secret. It retries for about three days.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ connectionId: string; kind: string }> },
) {
  const { connectionId, kind } = await params;
  if (kind !== "inbound" && kind !== "events") return new Response("Not found", { status: 404 });
  let result: { status: number };
  if (kind === "inbound") {
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    result = await handleMailersendInbound(connectionId, { key: new URL(request.url).searchParams.get("key"), payload: payload as never });
  } else {
    // The signature covers the body exactly as sent.
    const body = new Uint8Array(await request.arrayBuffer());
    result = await handleMailersendEvents(connectionId, { signature: request.headers.get("signature"), body });
  }
  return new Response(result.status === 200 ? "OK" : null, { status: result.status });
}
