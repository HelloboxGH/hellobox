import { describe, expect, test } from "bun:test";
import { safeAvatarUrl, sniffAvatarType } from "./avatar";

const bytes = (...values: number[]) => new Uint8Array(values);
const text = (value: string) => new TextEncoder().encode(value);

describe("sniffAvatarType", () => {
  test("recognizes real images by their bytes", () => {
    expect(sniffAvatarType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe("png");
    expect(sniffAvatarType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("jpg");
    expect(sniffAvatarType(text("RIFF\0\0\0\0WEBPVP8 "))).toBe("webp");
  });

  test("refuses anything that could run or isn't an image", () => {
    expect(sniffAvatarType(text("<svg onload='alert(1)'/>"))).toBeNull();
    expect(sniffAvatarType(text("<html><script>alert(1)</script>"))).toBeNull();
    expect(sniffAvatarType(text("GIF89a"))).toBeNull();
    expect(sniffAvatarType(text("RIFF\0\0\0\0WAVE"))).toBeNull();
    expect(sniffAvatarType(bytes())).toBeNull();
  });
});

describe("safeAvatarUrl", () => {
  test("keeps our files and sign-in photos", () => {
    const own = "/api/avatars/user_1/3f2b8a10-1111-4222-8333-444455556666.webp";
    expect(safeAvatarUrl(own)).toBe(own);
    expect(safeAvatarUrl("https://lh3.googleusercontent.com/a/photo")).toContain("googleusercontent");
    expect(safeAvatarUrl("https://avatars.githubusercontent.com/u/1")).toContain("githubusercontent");
  });

  test.each([
    null,
    "",
    "https://tracker.example.com/pixel.png",
    "http://lh3.googleusercontent.com/a",
    "https://lh3.googleusercontent.com.evil.test/a",
    "javascript:alert(1)",
    "data:image/svg+xml,<svg/>",
    "/api/avatars/../../secret",
    "/api/attachments/1",
  ])("drops %s", (image) => {
    expect(safeAvatarUrl(image)).toBeNull();
  });
});
