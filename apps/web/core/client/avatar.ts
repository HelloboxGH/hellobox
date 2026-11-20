const SIZE = 256;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

// Crops to a square and scales down in the browser, which also removes location data
// and anything else stored in the photo's metadata.
export async function toAvatarBlob(file: File) {
  if (file.size > MAX_SOURCE_BYTES) throw new Error("That image is too large");
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("We couldn't read that image. Try a PNG, JPEG or WebP");
  }
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("We couldn't read that image. Try a PNG, JPEG or WebP");
  context.imageSmoothingQuality = "high";
  context.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    SIZE,
    SIZE,
  );
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.85));
  if (!blob) throw new Error("We couldn't read that image. Try a PNG, JPEG or WebP");
  return blob;
}

async function send(method: "POST" | "DELETE", body?: Blob) {
  const res = await fetch("/api/account/avatar", { method, body });
  const result = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new Error(result?.error ?? "Couldn't update your photo. Please try again");
}

export const uploadAvatar = async (file: File) => send("POST", await toAvatarBlob(file));
export const removeAvatar = () => send("DELETE");
