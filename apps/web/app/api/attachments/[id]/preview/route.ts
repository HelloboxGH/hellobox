import { IMAGE_HEADER_BYTES, previewType } from "@hellobox/mail";
import { readStart, signedPreviewUrl } from "@hellobox/storage";
import { headers } from "next/headers";
import { getAuth } from "@/core/auth";
import { readableAttachment } from "@/core/server/readable-attachment";

// Where an <img> finds a file. Its own bytes decide whether it's an image, never its name
// or what the sender called it; anything else answers 415 and stays a download.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) return new Response("Unauthorized", { status: 401 });
  const file = await readableAttachment((await params).id, session.user.id);
  if (!file) return new Response("Not found", { status: 404 });
  const type = file.size > 0 ? previewType(await readStart(file.storageKey, IMAGE_HEADER_BYTES)) : null;
  if (!type) return new Response("Not an image", { status: 415 });
  return new Response(null, {
    status: 302,
    headers: { Location: await signedPreviewUrl(file.storageKey, type), "Cache-Control": "no-store" },
  });
}
