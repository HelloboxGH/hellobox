import { call } from "@/core/client/api";
import { toAvatarBlob } from "@/core/client/avatar";

// Cropped and scaled like profile photos, then base64, as the logo actions take it.
export async function logoToBase64(file: File) {
  const blob = await toAvatarBlob(file);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function uploadWorkspaceLogo(file: File) {
  return call("/workspace/logo", { image: await logoToBase64(file) });
}

export const removeWorkspaceLogo = () => call("/workspace/logo", { image: null });
