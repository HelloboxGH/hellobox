import { avatarKey, streamToStorage } from "@hellobox/storage";
import { headers } from "next/headers";
import { getAuth } from "@/core/auth";
import { avatarTypes, MAX_AVATAR_BYTES, sniffAvatarType } from "@/core/avatar";
import { removeStoredAvatar } from "@/core/server/avatar-store";

const fail = (error: string, status: number) => Response.json({ error }, { status });

async function readLimited(request: Request) {
  if (!request.body) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_AVATAR_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

export async function POST(request: Request) {
  const requestHeaders = await headers();
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) return fail("Please sign in", 401);
  if (session.user.isAnonymous) return fail("Sign up free to add a photo", 403);
  if (Number(request.headers.get("content-length") ?? 0) > MAX_AVATAR_BYTES) {
    return fail("That image is too large", 413);
  }
  const bytes = await readLimited(request);
  if (!bytes) return fail("That image is too large", 413);
  const extension = sniffAvatarType(bytes);
  if (!extension) return fail("Use a PNG, JPEG or WebP image", 415);

  const file = `${crypto.randomUUID()}.${extension}`;
  const url = `/api/avatars/${session.user.id}/${file}`;
  try {
    await streamToStorage(avatarKey(session.user.id, file), bytes as never, avatarTypes[extension]);
    await auth.api.updateUser({ headers: requestHeaders, body: { image: url } });
  } catch (error) {
    console.error("[avatar] Upload failed:", error);
    return fail("Couldn't save your photo. Please try again", 502);
  }
  await removeStoredAvatar(session.user.image);
  return Response.json({ url });
}

export async function DELETE() {
  const requestHeaders = await headers();
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) return fail("Please sign in", 401);
  if (session.user.isAnonymous) return fail("Sign up free to add a photo", 403);
  await auth.api.updateUser({ headers: requestHeaders, body: { image: null } });
  await removeStoredAvatar(session.user.image);
  return Response.json({ url: null });
}
