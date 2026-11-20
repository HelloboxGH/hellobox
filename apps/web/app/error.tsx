"use client";

import { ErrorContent } from "@/components/error-content";

export default function ErrorPage({ error, retry }: { error: unknown; retry: () => void }) {
  return <ErrorContent error={error} retry={retry} />;
}
