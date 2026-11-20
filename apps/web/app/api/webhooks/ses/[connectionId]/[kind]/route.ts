import { handleSesNotification } from "@hellobox/mail";
import { SnsVerificationError, verifySnsMessage } from "@hellobox/providers";

// SNS posts delivery events and new-mail notifications from the customer's account.
// It sends JSON as text/plain, so the body is parsed by hand.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ connectionId: string; kind: string }> },
) {
  const { connectionId, kind } = await params;
  if (kind !== "events" && kind !== "inbound") return new Response("Not found", { status: 404 });
  let body: unknown;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  try {
    const message = await verifySnsMessage(body);
    const { status } = await handleSesNotification(connectionId, kind, message);
    return new Response(null, { status });
  } catch (error) {
    if (error instanceof SnsVerificationError) return new Response("Invalid signature", { status: 401 });
    throw error;
  }
}
