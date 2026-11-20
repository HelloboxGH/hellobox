"use client";

import { type ReactNode, useEffect, useRef } from "react";

// Custom events for whatever analytics a build adds. It defines window.hbTrack (from a
// site head script, before the page runs); without one, track() does nothing.

type Props = Record<string, string | number | boolean>;

declare global {
  interface Window {
    hbTrack?: (name: string, props?: Props) => void;
  }
}

export function track(name: string, props?: Props) {
  try {
    window.hbTrack?.(name, props);
  } catch {
    // Analytics never gets in the way.
  }
}

// How long something was actually on screen, such as a plan's benefits. Sent once, when
// it leaves view, the tab hides or the page closes, and only past a second.
export function ViewTime({ event, props, className, children }: { event: string; props: Props; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let since: number | null = null;
    let total = 0;
    const pause = () => {
      if (since !== null) total += performance.now() - since;
      since = null;
    };
    const flush = () => {
      pause();
      if (total >= 1000) track(event, { ...latest.current, seconds: Math.round(total / 1000) });
      total = 0;
    };
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting && document.visibilityState === "visible") since ??= performance.now();
      else flush();
    }, { threshold: 0.6 });
    const onVisibility = () => (document.visibilityState === "hidden" ? flush() : undefined);
    observer.observe(element);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flush);
    return () => {
      flush();
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flush);
    };
  }, [event]);

  return <div ref={ref} className={className}>{children}</div>;
}
