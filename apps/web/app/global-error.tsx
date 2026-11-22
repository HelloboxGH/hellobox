"use client";

import "./globals.css";
import { ErrorContent } from "@/components/error-content";
import { themeScript } from "@/components/theme";

// Replaces the root layout when it crashes, so it renders its own document.
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <title>Something went wrong · HelloBox</title>
        {/* eslint-disable-next-line react/no-danger -- our own constant script that applies the saved theme before paint */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="font-sans antialiased">
        <ErrorContent error={error} retry={retry} />
      </body>
    </html>
  );
}
