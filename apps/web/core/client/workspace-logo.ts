import { call } from "@/core/client/api";
import { toAvatarBlob } from "@/core/client/avatar";

// Cropped and scaled like profile photos, then sent as base64 to an admin-only action.
export async function uploadWorkspaceLogo(file: File) {
  const blob = await toAvatarBlob(file);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return call("/workspace/logo", { image: btoa(binary) });
}

export const removeWorkspaceLogo = () => call("/workspace/logo", { image: null });
