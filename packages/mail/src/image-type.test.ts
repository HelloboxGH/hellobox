import { describe, expect, test } from "bun:test";
import { imageInfo, previewType } from "./image-type";

const bytes = (...parts: (string | number[])[]) =>
  Uint8Array.from(parts.flatMap((part) => (typeof part === "string" ? [...part].map((c) => c.charCodeAt(0)) : part)));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const png = (w: number, h: number) => bytes("\x89PNG\r\n\x1a\n", be32(13), "IHDR", be32(w), be32(h), [8, 6, 0, 0, 0]);
const gif = (w: number, h: number) => bytes("GIF89a", [w & 255, w >> 8, h & 255, h >> 8, 0, 0]);
const sof = (w: number, h: number) => [0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 0, 0, 0];
const jpeg = (w: number, h: number, pad = 10) => bytes([0xff, 0xd8, 0xff, 0xe1, (pad + 2) >> 8, (pad + 2) & 255], Array<number>(pad).fill(0xff), sof(w, h));
const webp = (kind: string, rest: number[]) => bytes("RIFF", [0, 0, 0, 0], "WEBP", kind, [0, 0, 0, 0], rest, Array<number>(20).fill(0));

describe("images", () => {
  test("are known by their bytes, with their size", () => {
    expect(imageInfo(png(640, 480))).toEqual({ type: "image/png", width: 640, height: 480 });
    expect(imageInfo(gif(300, 2))).toEqual({ type: "image/gif", width: 300, height: 2 });
    expect(imageInfo(jpeg(4032, 3024, 60_000))).toEqual({ type: "image/jpeg", width: 4032, height: 3024 });
    expect(imageInfo(webp("VP8X", [0, 0, 0, 0, 0xff, 3, 0, 0x1f, 1, 0]))).toEqual({ type: "image/webp", width: 1024, height: 288 });
    expect(imageInfo(webp("VP8 ", [0, 0, 0, 0x9d, 1, 0x2a, 0x80, 2, 0xe0, 1]))).toEqual({ type: "image/webp", width: 640, height: 480 });
    expect(imageInfo(webp("VP8L", [0x2f, ...[(639 | (479 << 14)) >>> 0].flatMap((n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24])]))).toEqual({ type: "image/webp", width: 640, height: 480 });
  });
  test("are nothing else", () => {
    for (const other of ["<html><script>", "<svg xmlns=", "%PDF-1.7", "", "GIF87", "RIFF0000WAVEfmt 0000"]) {
      expect(previewType(bytes(other))).toBeNull();
    }
  });
  test("aren't shown when huge, cut short or broken", () => {
    expect(previewType(png(8000, 5000))).toBe("image/png");
    expect(previewType(png(8000, 5001))).toBeNull();
    expect(previewType(png(0xffffffff, 0xffffffff))).toBeNull();
    expect(previewType(png(0, 10))).toBeNull();
    expect(previewType(jpeg(10, 10, 60_000).subarray(0, 1000))).toBeNull();
    expect(previewType(bytes([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
    expect(previewType(webp("VP8?", []))).toBeNull();
  });
});
