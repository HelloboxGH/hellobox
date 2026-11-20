import { handleMailgunEvent, handleMailgunInbound } from "@hellobox/mail";

// Mailgun posts stored mail to /inbound as a form, and delivery events to /events as
// JSON, both signed with the account's webhook signing key. It retries anything but a
// 200 (or a 406) for about eight hours.
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
    // Attachments come as files; only the text fields are needed, since we fetch the
    // raw message from Mailgun.
    const fields: Record<string, string> = {};
    for (const [key, value] of form.entries()) if (typeof value === "string") fields[key] = value;
    result = await handleMailgunInbound(connectionId, fields);
  } else {
    let body: unknown;
    try {
      body = JSON.parse(await request.text());
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    result = await handleMailgunEvent(connectionId, body as Parameters<typeof handleMailgunEvent>[1]);
  }
  return new Response(result.status === 200 ? "OK" : null, { status: result.status });
}
