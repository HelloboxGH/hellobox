import { deleteObject, logoKey, streamToStorage } from "@hellobox/storage";
import { badRequest } from "nezt";
import { z } from "zod";
import { avatarTypes, MAX_AVATAR_BYTES, safeLogoUrl, sniffAvatarType } from "@/core/avatar";

// A logo as the browser sends it: cropped and scaled (core/client/avatar.ts), in base64.
export const logoImage = z.base64().max(Math.ceil((MAX_AVATAR_BYTES * 4) / 3) + 4);

// Saves a workspace's logo (its own, or a custom provider's) and returns its URL, served
// to members by /api/logos. Goes by the file's bytes, never the type the browser claims.
export async function storeLogo(workspaceId: string, image: string) {
  const bytes = new Uint8Array(Buffer.from(image, "base64"));
  const extension = sniffAvatarType(bytes);
  if (!extension) throw badRequest("Use a PNG, JPEG or WebP image");
  const file = `${crypto.randomUUID()}.${extension}`;
  await streamToStorage(logoKey(workspaceId, file), bytes as never, avatarTypes[extension]);
  return `/api/logos/${workspaceId}/${file}`;
}

// A leftover old file costs little and shouldn't fail the change.
export async function removeStoredLogo(workspaceId: string, url: string | null | undefined) {
  const file = safeLogoUrl(url)?.split("/").at(-1);
  if (!file || safeLogoUrl(url) !== `/api/logos/${workspaceId}/${file}`) return;
  await deleteObject(logoKey(workspaceId, file)).catch((error: unknown) => {
    console.error("[logo] Couldn't delete the old file:", error);
  });
}
