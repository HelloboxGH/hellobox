import { handleCustomEvents } from "@hellobox/mail";

// A custom provider's delivery events, read with its spec. The address carries our key;
// the spec may add the provider's own signature check, which needs the body as sent.
export async function POST(request: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  const { connectionId } = await params;
  const key = new URL(request.url).searchParams.get("key");
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  const body = new Uint8Array(await request.arrayBuffer());
  const result = await handleCustomEvents(connectionId, { key, headers, body });
  return new Response(result.status === 200 ? "OK" : null, { status: result.status });
}
