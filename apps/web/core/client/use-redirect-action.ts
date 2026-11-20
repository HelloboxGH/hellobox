"use client";

import { useCallback, useEffect, useState } from "react";

type Result = { error?: { message?: string } | null } | undefined | void;

/**
 * For buttons that send the browser to another site (Google, GitHub, SSO). Once one is
 * pressed, `pending` names it until the page is left, so every such button can stay
 * disabled. An error lets them be pressed again, and so does coming back with the Back
 * button, which can restore the page from the back/forward cache still disabled.
 */
export function useRedirectAction(onError?: (message: string) => void) {
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) setPending(null);
    };
    window.addEventListener("pageshow", restored);
    return () => window.removeEventListener("pageshow", restored);
  }, []);

  const run = useCallback(
    async (key: string, action: () => Promise<Result>, fallback = "We couldn't reach that sign-in page") => {
      setPending(key);
      try {
        const result = await action();
        if (result?.error) {
          setPending(null);
          onError?.(result.error.message ?? fallback);
        }
      } catch (error) {
        setPending(null);
        onError?.(error instanceof Error ? error.message : fallback);
      }
    },
    [onError],
  );

  return { pending, run };
}
