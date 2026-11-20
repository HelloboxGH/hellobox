// Shared by the server and the client.
const OWN_AVATAR = /^\/api\/avatars\/[\w-]{1,64}\/[0-9a-f-]{36}\.(?:png|jpg|webp)$/;
const SIGN_IN_AVATAR_HOSTS = new Set(["lh3.googleusercontent.com", "avatars.githubusercontent.com"]);

const OWN_LOGO = /^\/api\/logos\/[\w-]{1,64}\/[0-9a-f-]{36}\.(?:png|jpg|webp)$/;

// Workspace logos are only ever our own files.
export const safeLogoUrl = (logo: string | null | undefined) => (logo && OWN_LOGO.test(logo) ? logo : null);

export const MAX_AVATAR_BYTES = 1024 * 1024;

export const avatarTypes = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
} as const;

export type AvatarExtension = keyof typeof avatarTypes;

// Better Auth lets a user set any image URL on their account, and teammates load what's
// shown here. Anything other than our files and sign-in photos could track who views it.
export function safeAvatarUrl(image: string | null | undefined) {
  if (!image) return null;
  if (OWN_AVATAR.test(image)) return image;
  try {
    const url = new URL(image);
    return url.protocol === "https:" && SIGN_IN_AVATAR_HOSTS.has(url.hostname) ? image : null;
  } catch {
    return null;
  }
}

// Goes by the file's own bytes. The type a browser claims can say anything.
export function sniffAvatarType(bytes: Uint8Array): AvatarExtension | null {
  const starts = (signature: number[], offset = 0) =>
    signature.every((byte, index) => bytes[offset + index] === byte);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (starts([0xff, 0xd8, 0xff])) return "jpg";
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "webp";
  return null;
}
