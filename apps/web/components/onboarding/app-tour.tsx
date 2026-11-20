"use client";

import { useEffect, useRef, useState } from "react";
import { Logo } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface TourStep {
  id: string;
  title: string;
  description: string;
  // Matches a data-tour attribute. Steps without one sit in the middle of the screen.
  target?: string;
}

const STEPS: TourStep[] = [
  {
    id: "welcome",
    title: "Welcome to HelloBox",
    description: "A real inbox for the email you already send. Here's a quick look around.",
  },
  {
    id: "connect",
    target: "connect",
    title: "Start by connecting your provider",
    description: "Connect Amazon SES, Resend, Postmark or Mailgun. We import your domains and set up receiving, so your mail starts arriving here.",
  },
  {
    id: "compose",
    target: "compose",
    title: "Write from your own domain",
    description: "Press C anywhere to start an email. You can schedule it, or undo right after sending.",
  },
  {
    id: "views",
    target: "views",
    title: "All your mail, in one place",
    description: "Your inbox, drafts, and everything you've sent or scheduled live here.",
  },
  {
    id: "sorted",
    target: "sorted",
    title: "Sorted for you",
    description: "Purchases and important mail get their own views. Archive, spam and trash are one click away.",
  },
  {
    id: "search",
    target: "search",
    title: "Find anything",
    description: "Press / to search your mail, or ⌘K to open the command palette. J and K move through the list.",
  },
  {
    id: "account",
    target: "account",
    title: "Your account",
    description: "Change your theme, open settings or sign out. You can replay this tour from Settings.",
  },
  {
    id: "done",
    title: "You're all set",
    description: "One more thing: add your own AI key in Settings, and it can draft replies for you. It can't send anything.",
  },
];

const GAP = 14;
const MARGIN = 12;
const PADDING = 6;

const findTarget = (step: TourStep | undefined) =>
  step?.target ? document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`) : null;

// Off-screen counts as missing: on phones the sidebar sits outside the viewport.
function isVisible(element: HTMLElement | null) {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.left < window.innerWidth;
}

function place(rect: DOMRect, width: number, height: number) {
  const fitsRight = rect.right + GAP + width + MARGIN <= window.innerWidth;
  const fitsLeft = rect.left - GAP - width - MARGIN >= 0;
  const fitsBelow = rect.bottom + GAP + height + MARGIN <= window.innerHeight;
  let left = rect.left;
  let top = rect.top;
  if (fitsRight) left = rect.right + GAP;
  else if (fitsLeft) left = rect.left - GAP - width;
  else top = fitsBelow ? rect.bottom + GAP : rect.top - GAP - height;
  return {
    left: Math.min(Math.max(left, MARGIN), window.innerWidth - width - MARGIN),
    top: Math.min(Math.max(top, MARGIN), window.innerHeight - height - MARGIN),
  };
}

// Dims the app around one element at a time, and leaves the app usable underneath.
export function AppTour({ onClose }: { onClose: () => void }) {
  const [steps, setSteps] = useState<TourStep[] | null>(null);
  const [index, setIndex] = useState(0);
  const spotlight = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const step = steps?.[index];
  const last = Boolean(steps) && index === (steps?.length ?? 0) - 1;

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setSteps(STEPS.filter((item) => !item.target || isVisible(findTarget(item))));
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!step) return;
    primary.current?.focus({ preventScroll: true });
    const target = findTarget(step);
    target?.scrollIntoView({ block: "nearest" });
    let frame = 0;
    let previous = "";
    const track = () => {
      const light = spotlight.current;
      const popup = card.current;
      if (light && popup) {
        const rect = target?.getBoundingClientRect() ?? null;
        const key = `${rect?.top}|${rect?.left}|${rect?.width}|${rect?.height}|${window.innerWidth}|${window.innerHeight}|${popup.offsetHeight}`;
        if (key !== previous) {
          previous = key;
          light.style.opacity = rect ? "1" : "0";
          if (rect) {
            light.style.top = `${rect.top - PADDING}px`;
            light.style.left = `${rect.left - PADDING}px`;
            light.style.width = `${rect.width + PADDING * 2}px`;
            light.style.height = `${rect.height + PADDING * 2}px`;
          }
          if (rect && window.innerWidth >= 640) {
            const { left, top } = place(rect, popup.offsetWidth, popup.offsetHeight);
            popup.style.left = `${left}px`;
            popup.style.top = `${top}px`;
            popup.style.transform = "";
          } else {
            popup.style.left = "";
            popup.style.top = "";
          }
        }
      }
      frame = requestAnimationFrame(track);
    };
    frame = requestAnimationFrame(track);
    return () => cancelAnimationFrame(frame);
  }, [step]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!steps || !step) return null;
  const anchored = Boolean(step.target);

  return (
    <>
      {!anchored && <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-[60] bg-black/45" />}
      <div
        ref={spotlight}
        aria-hidden="true"
        className="pointer-events-none fixed z-[60] rounded-xl opacity-0 shadow-[0_0_0_9999px_rgb(0_0_0/0.45)] ring-2 ring-brand motion-safe:transition-[top,left,width,height] motion-safe:duration-300 motion-safe:ease-out"
      />
      <div
        ref={card}
        role="dialog"
        aria-labelledby="tour-title"
        aria-describedby="tour-description"
        className={cn(
          "fixed inset-x-3 bottom-3 z-[61] space-y-3 rounded-2xl border bg-popover p-5 text-popover-foreground shadow-lg sm:inset-x-auto sm:bottom-auto sm:w-80",
          !anchored && "sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2",
        )}
      >
        {!anchored && <Logo size={40} />}
        <h2 id="tour-title" className="font-semibold text-base text-foreground tracking-tight">{step.title}</h2>
        <p id="tour-description" className="text-muted-foreground text-sm">{step.description}</p>
        <div className="flex items-center gap-2 pt-1">
          <span className="me-auto text-muted-foreground text-xs tabular-nums">{index + 1} of {steps.length}</span>
          {!last && <Button size="sm" variant="ghost" onClick={onClose}>Skip</Button>}
          {index > 0 && <Button size="sm" variant="outline" onClick={() => setIndex(index - 1)}>Back</Button>}
          <Button ref={primary} size="sm" onClick={() => (last ? onClose() : setIndex(index + 1))}>
            {last ? "Get started" : "Next"}
          </Button>
        </div>
      </div>
    </>
  );
}
