import { brevoTokenFrom, handleBrevoEvents, handleBrevoInbound } from "@hellobox/mail";

// Brevo posts received mail to /inbound (parsed JSON; attachments are fetched from Brevo)
// and delivery events to /events. It doesn't sign them: both carry the connection's
// token, as a bearer token and in X-HelloBox-Token.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ connectionId: string; kind: string }> },
) {
  const { connectionId, kind } = await params;
  if (kind !== "inbound" && kind !== "events") return new Response("Not found", { status: 404 });
  const token = brevoTokenFrom({
    authorization: request.headers.get("authorization"),
    token: request.headers.get("x-hellobox-token"),
  });
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const result =
    kind === "inbound"
      ? await handleBrevoInbound(connectionId, { token, payload: payload as never })
      : await handleBrevoEvents(connectionId, { token, payload: payload as never });
  return new Response(result.status === 200 ? "OK" : null, { status: result.status });
}
