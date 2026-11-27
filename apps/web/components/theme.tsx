"use client";

import { usePathname } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";

export type ThemeMode = "system" | "light" | "dark";

const KEY = "hellobox.theme";
const ACCENT_KEY = "hellobox.accent";

export const ACCENTS = [
  { value: "periwinkle", label: "Periwinkle", color: "oklch(0.62 0.13 277)" },
  { value: "blue", label: "Blue", color: "oklch(0.62 0.14 245)" },
  { value: "teal", label: "Teal", color: "oklch(0.62 0.1 195)" },
  { value: "emerald", label: "Emerald", color: "oklch(0.62 0.13 155)" },
  { value: "amber", label: "Amber", color: "oklch(0.68 0.13 70)" },
  { value: "coral", label: "Coral", color: "oklch(0.62 0.15 32)" },
  { value: "rose", label: "Rose", color: "oklch(0.62 0.15 5)" },
  { value: "violet", label: "Violet", color: "oklch(0.62 0.14 305)" },
  { value: "carbon", label: "Carbon", color: "oklch(0.4 0.02 255)" },
  { value: "gray", label: "Gray", color: "oklch(0.62 0 0)" },
  { value: "ink", label: "Ink", color: "oklch(0.3 0.09 265)" },
  { value: "black", label: "Black", color: "oklch(0.18 0 0)" },
] as const;

export type Accent = (typeof ACCENTS)[number]["value"];

// Light and blue until someone picks otherwise.
const DEFAULT_THEME = "light";
const DEFAULT_ACCENT: Accent = "blue";

// The landing pages (home, pricing, partners, guides, providers), the legal pages and the sign-in pages
// always show the brand look, whatever the visitor picked inside the app. A new landing page goes here.
const BRAND_PAGES = "^/(login|signup|forgot-password|reset-password|admin|pricing|partners|guides|providers|demo|privacy|terms)?(/|$)";
const isBrandPage = (path: string) => new RegExp(BRAND_PAGES).test(path);

export const themeScript = `(function(){var r=document.documentElement,b=new RegExp(${JSON.stringify(BRAND_PAGES)}).test(location.pathname),t="${DEFAULT_THEME}",a="${DEFAULT_ACCENT}";if(!b){try{t=localStorage.getItem("${KEY}")||t;a=localStorage.getItem("${ACCENT_KEY}")||a}catch(e){}}r.classList.toggle("dark",t==="dark"||(t==="system"&&matchMedia("(prefers-color-scheme: dark)").matches));if(a!=="periwinkle")r.dataset.accent=a})()`;

const listeners = new Set<() => void>();

function read(): ThemeMode {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" || value === "system" ? value : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

function apply() {
  const root = document.documentElement;
  const brand = isBrandPage(location.pathname);
  const mode = brand ? DEFAULT_THEME : read();
  const dark =
    mode === "dark" ||
    (mode === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  root.classList.toggle("dark", dark);
  const accent = brand ? DEFAULT_ACCENT : readAccent();
  if (accent === "periwinkle") delete root.dataset.accent;
  else root.dataset.accent = accent;
}

export function setTheme(mode: ThemeMode) {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    // Storage can be blocked. The theme still applies for this page.
  }
  apply();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const media = matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    apply();
    listener();
  };
  media.addEventListener("change", onChange);
  return () => {
    listeners.delete(listener);
    media.removeEventListener("change", onChange);
  };
}

function readAccent(): Accent {
  try {
    const value = localStorage.getItem(ACCENT_KEY);
    return ACCENTS.some((accent) => accent.value === value) ? (value as Accent) : DEFAULT_ACCENT;
  } catch {
    return DEFAULT_ACCENT;
  }
}

export function setAccent(accent: Accent) {
  try {
    localStorage.setItem(ACCENT_KEY, accent);
  } catch {
    // Storage can be blocked. The accent still applies for this page.
  }
  apply();
  for (const listener of listeners) listener();
}

// Moving between the brand pages and the app without a reload swaps the look over.
export function ThemeSync() {
  const pathname = usePathname();
  useEffect(() => {
    apply();
    for (const listener of listeners) listener();
  }, [pathname]);
  return null;
}

export const useAccent = () =>
  useSyncExternalStore(subscribe, readAccent, () => DEFAULT_ACCENT);

export const useIsDark = () =>
  useSyncExternalStore(
    subscribe,
    () => document.documentElement.classList.contains("dark"),
    () => false,
  );

export const useTheme = () =>
  useSyncExternalStore(subscribe, read, () => DEFAULT_THEME as ThemeMode);
