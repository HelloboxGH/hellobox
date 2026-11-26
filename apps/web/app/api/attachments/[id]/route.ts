import { signedDownloadUrl } from "@hellobox/storage";
import { headers } from "next/headers";
import { getAuth } from "@/core/auth";
import { readableAttachment } from "@/core/server/readable-attachment";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) return new Response("Unauthorized", { status: 401 });
  const file = await readableAttachment((await params).id, session.user.id);
  if (!file) return new Response("Not found", { status: 404 });
  return Response.redirect(await signedDownloadUrl(file.storageKey, file.filename, file.contentType));
}
