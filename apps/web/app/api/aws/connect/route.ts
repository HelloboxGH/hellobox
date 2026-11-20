import { handleStackCallback } from "@hellobox/mail";
import { parseStackCallback } from "@hellobox/providers";
import { enqueueSesProvision } from "@hellobox/queue";

// The CloudFormation stack in a customer's AWS account reports its new role here. The
// connect token, known only to that stack, proves which connection it belongs to.
export async function POST(request: Request) {
  const callback = parseStackCallback(await request.json().catch(() => null));
  if (!callback) return new Response("Bad request", { status: 400 });
  const result = await handleStackCallback(callback, enqueueSesProvision);
  return result.ok ? new Response(null, { status: 204 }) : new Response("Not found", { status: 404 });
}
