import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "HelloBox",
    short_name: "HelloBox",
    description: "A real inbox for Amazon SES, Resend, Postmark and Mailgun.",
    start_url: "/inbox",
    display: "standalone",
    background_color: "#f4f5fb",
    theme_color: "#f4f5fb",
    icons: [
      { src: "/android-chrome-192x192.png", sizes: "192x192", type: "image/png" },
      { src: "/android-chrome-512x512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
