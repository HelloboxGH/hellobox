import type { Metadata, Viewport } from "next";
import { Geist_Mono, Instrument_Serif, Inter } from "next/font/google";
import { Suspense } from "react";
import "./globals.css";
import { themeScript, ThemeSync } from "@/components/theme";
import { getExtensions } from "@/core/extensions";
import { SITE_NAME, siteUrl } from "@/core/site";
import { cn } from "@/lib/utils";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });
const interHeading = Inter({ subsets: ["latin"], variable: "--font-heading" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });
const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  variable: "--font-instrument-serif",
  weight: "400",
});

// What the open app says about itself. A marketing site (cloud) adds its own on top.
export async function generateMetadata(): Promise<Metadata> {
  return {
    metadataBase: siteUrl(),
    applicationName: SITE_NAME,
    title: { default: SITE_NAME, template: `%s · ${SITE_NAME}` },
    description: "A shared inbox for Amazon SES, Resend, Postmark and Mailgun.",
    icons: {
      icon: [
        { url: "/favicon.ico", sizes: "any" },
        { url: "/android-chrome-192x192.png", sizes: "192x192", type: "image/png" },
      ],
    },
    ...getExtensions().site?.metadata,
  };
}

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f5fb" },
    { media: "(prefers-color-scheme: dark)", color: "#14141c" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  const Head = getExtensions().site?.head;
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn(
        "h-full antialiased",
        inter.variable,
        interHeading.variable,
        geistMono.variable,
        instrumentSerif.variable,
      )}
    >
      <head>
        {/* Runs before paint so the saved theme never flashes. */}
        {/* eslint-disable-next-line react/no-danger -- our own constant script that applies the saved theme before paint */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="relative min-h-full">
        {/* Reads the path, which only exists at runtime, so it streams in after prerendering. */}
        <Suspense fallback={null}><ThemeSync /></Suspense>
        <div className="isolate relative flex min-h-svh flex-col">{children}</div>
        {Head && <Head />}
      </body>
    </html>
  );
}
