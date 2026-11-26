export type ImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface ImageInfo {
  type: ImageType;
  // Null when the header doesn't say within the bytes there are.
  width: number | null;
  height: number | null;
}

// Enough for a photo's camera details and color profile, which come before its size.
export const IMAGE_HEADER_BYTES = 256 * 1024;
const MAX_PIXELS = 40_000_000;

const text = (bytes: Uint8Array, at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length));

function jpegSize(bytes: Uint8Array) {
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    // Padding, and markers that stand alone.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) return { height: (bytes[at + 5]! << 8) | bytes[at + 6]!, width: (bytes[at + 7]! << 8) | bytes[at + 8]! };
    const length = (bytes[at + 2]! << 8) | bytes[at + 3]!;
    // The picture itself began, or the header is broken.
    if (marker === 0xda || length < 2) return null;
    at += 2 + length;
  }
  return null;
}

function webpSize(bytes: Uint8Array) {
  if (bytes.length < 30) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (text(bytes, 12, 4)) {
    case "VP8X":
      return { width: 1 + (view.getUint32(24, true) & 0xffffff), height: 1 + (view.getUint32(26, true) >>> 8) };
    case "VP8 ":
      if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
      return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    case "VP8L": {
      if (bytes[20] !== 0x2f) return null;
      const bits = view.getUint32(21, true);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
    }
    default:
      return null;
  }
}

/** What a file's first bytes say it is. Only reads the header: nothing is ever decoded. */
export function imageInfo(bytes: Uint8Array): ImageInfo | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const unknown = { width: null, height: null };
  if (bytes.length >= 24 && text(bytes, 0, 8) === "\x89PNG\r\n\x1a\n") {
    const size = text(bytes, 12, 4) === "IHDR" ? { width: view.getUint32(16), height: view.getUint32(20) } : unknown;
    return { type: "image/png", ...size };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { type: "image/jpeg", ...(jpegSize(bytes) ?? unknown) };
  }
  if (bytes.length >= 10 && /^GIF8[79]a$/.test(text(bytes, 0, 6))) {
    return { type: "image/gif", width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (bytes.length >= 16 && text(bytes, 0, 4) === "RIFF" && text(bytes, 8, 4) === "WEBP") {
    return { type: "image/webp", ...(webpSize(bytes) ?? unknown) };
  }
  return null;
}

/** The type to show a file as, or null when it's a download. */
export function previewType(bytes: Uint8Array): ImageType | null {
  const info = imageInfo(bytes);
  if (!info?.width || !info.height || info.width * info.height > MAX_PIXELS) return null;
  return info.type;
}
