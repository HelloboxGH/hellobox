import { avatarKey, readObject } from "@hellobox/storage";
import { headers } from "next/headers";
import { getAuth } from "@/core/auth";
import { type AvatarExtension, avatarTypes } from "@/core/avatar";

const FILE = /^[0-9a-f-]{36}\.(png|jpg|webp)$/;
const USER_ID = /^[\w-]{1,64}$/;

// The bucket is private, so photos come through here. The name changes with every upload,
// which lets browsers keep them for good.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ userId: string; file: string }> },
) {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) return new Response("Unauthorized", { status: 401 });
  const { userId, file } = await params;
  const extension = file.match(FILE)?.[1] as AvatarExtension | undefined;
  if (!extension || !USER_ID.test(userId)) return new Response("Not found", { status: 404 });
  try {
    return new Response(await readObject(avatarKey(userId, file)), {
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
