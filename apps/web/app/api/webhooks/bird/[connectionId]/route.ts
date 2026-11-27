import { handleBirdWebhook } from "@hellobox/mail";

// Bird posts delivery events and received-mail notices here, signed the Standard Webhooks
// way. It retries 8 times over about a day; received mail is also found by backfill.
export async function POST(request: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  const { connectionId } = await params;
  // The signature covers the body exactly as sent.
  const body = new Uint8Array(await request.arrayBuffer());
  const result = await handleBirdWebhook(connectionId, {
    id: request.headers.get("webhook-id"),
    timestamp: request.headers.get("webhook-timestamp"),
    signature: request.headers.get("webhook-signature"),
    body,
  });
  return new Response(result.status === 200 ? "OK" : null, { status: result.status });
}
