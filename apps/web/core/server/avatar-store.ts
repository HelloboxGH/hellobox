import { avatarKey, deleteObject } from "@hellobox/storage";
import { safeAvatarUrl } from "@/core/avatar";

// A leftover file costs little, and shouldn't fail the change the user asked for.
export async function removeStoredAvatar(image: string | null | undefined) {
  const path = safeAvatarUrl(image);
  if (!path?.startsWith("/api/avatars/")) return;
  const [userId, file] = path.slice("/api/avatars/".length).split("/");
  if (!userId || !file) return;
  await deleteObject(avatarKey(userId, file)).catch((error: unknown) => {
    console.error("[avatar] Couldn't delete the file:", error);
  });
}
