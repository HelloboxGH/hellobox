import { handleSendgridEvents, handleSendgridInbound } from "@hellobox/mail";

// SendGrid posts received mail to /inbound as a form (Inbound Parse, raw MIME in `email`),
// checked by the key in the address, and delivery events to /events as signed JSON. It
// retries events for 24 hours; mail it couldn't post is retried for a while too.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ connectionId: string; kind: string }> },
) {
  const { connectionId, kind } = await params;
  if (kind !== "inbound" && kind !== "events") return new Response("Not found", { status: 404 });
  let result: { status: number };
  if (kind === "inbound") {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    const fields: Record<string, string> = {};
    for (const [key, value] of form.entries()) if (typeof value === "string") fields[key] = value;
    result = await handleSendgridInbound(connectionId, { key: new URL(request.url).searchParams.get("key"), fields });
  } else {
    // The signature covers the body exactly as sent.
    const body = new Uint8Array(await request.arrayBuffer());
    result = await handleSendgridEvents(connectionId, {
      signature: request.headers.get("x-twilio-email-event-webhook-signature"),
      timestamp: request.headers.get("x-twilio-email-event-webhook-timestamp"),
      body,
    });
  }
  return new Response(result.status === 200 ? "OK" : null, { status: result.status });
}
