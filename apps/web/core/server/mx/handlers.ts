import {
  checkMxSignature,
  MX_HEADERS,
  MX_MAX_BYTES,
  mxRecipientDecision,
  parseMxEnvelope,
  receiveFromMx,
} from "@hellobox/mail";

// The mail server (apps/mx) calls these. Its replies to senders follow our status codes:
// 2xx → 250, 422 → 550, anything else → 451 so the sender tries again later.

const json = (body: unknown, status = 200) => Response.json(body, { status });

// Reads at most `limit` bytes, counting what actually arrives: Content-Length can lie.
async function readBody(request: Request, limit: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > limit) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function verify(request: Request, path: string, envelope: string, body: Uint8Array) {
  return checkMxSignature({
    timestamp: request.headers.get(MX_HEADERS.timestamp),
    signature: request.headers.get(MX_HEADERS.signature),
    path,
    envelope,
    body,
  });
}

// Whether to accept RCPT TO for an address. Body: {"recipient": "..."}. Answers
// {"accept": boolean, "scope": "domain" | "address"}: how widely the mail server may cache it.
export async function checkRecipient(request: Request) {
  const path = "/api/mx/v1/recipients";
  const body = await readBody(request, 4096);
  if (!body) return json({ error: "Too large" }, 413);
  const check = verify(request, path, "", body);
  if (!check.ok) return json({ error: "Unauthorized" }, check.status);
  let recipient: unknown;
  try {
    recipient = (JSON.parse(new TextDecoder().decode(body)) as { recipient?: unknown }).recipient;
  } catch {
    return json({ error: "Bad request" }, 400);
  }
  if (typeof recipient !== "string") return json({ error: "Bad request" }, 400);
  return json(await mxRecipientDecision(recipient));
}

// The raw message as the body, the SMTP envelope in a header. Stored before we answer.
export async function receiveMessage(request: Request) {
  const path = "/api/mx/v1/messages";
  const envelopeHeader = request.headers.get(MX_HEADERS.envelope) ?? "";
  const body = await readBody(request, MX_MAX_BYTES);
  if (!body) return json({ error: "Too large" }, 413);
  const check = verify(request, path, envelopeHeader, body);
  if (!check.ok) return json({ error: "Unauthorized" }, check.status);
  const envelope = parseMxEnvelope(envelopeHeader);
  if (!envelope || !body.byteLength) return json({ error: "Bad request" }, 400);
  try {
    const result = await receiveFromMx(body, envelope);
    // The domain stopped receiving here between RCPT TO and now.
    if (result.status === "no-recipients") return json({ error: "No recipient receives mail here" }, 422);
    return json({ ids: result.ids });
  } catch (error) {
    console.error("[mx] Couldn't store a message:", error);
    return json({ error: "Try again later" }, 503);
  }
}
