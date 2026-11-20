import { getDb, members } from "@hellobox/db";
import { logoKey, readObject } from "@hellobox/storage";
import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { getAuth } from "@/core/auth";
import { type AvatarExtension, avatarTypes } from "@/core/avatar";

const FILE = /^[0-9a-f-]{36}\.(png|jpg|webp)$/;
const WORKSPACE_ID = /^[\w-]{1,64}$/;

// The bucket is private, so logos come through here, for members of that workspace only.
// The name changes with every upload, which lets browsers keep them for good.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ workspaceId: string; file: string }> },
) {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) return new Response("Unauthorized", { status: 401 });
  const { workspaceId, file } = await params;
  const extension = file.match(FILE)?.[1] as AvatarExtension | undefined;
  if (!extension || !WORKSPACE_ID.test(workspaceId)) return new Response("Not found", { status: 404 });
  const [member] = await getDb()
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.workspaceId, workspaceId), eq(members.userId, session.user.id)));
  if (!member) return new Response("Not found", { status: 404 });
  try {
    return new Response(await readObject(logoKey(workspaceId, file)), {
      headers: {
        "Content-Type": avatarTypes[extension],
        "Cache-Control": "private, max-age=31536000, immutable",
        "Content-Security-Policy": "default-src 'none'",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
