"use client";

import {
  Airplane, Bank, Bell, BookmarkSimple, Briefcase, Bug, Buildings, Calendar, ChartLine, ChatCircle, Code, Coffee,
  CreditCard, Crown, Fire, Flag, GameController, Gift, GraduationCap, Handshake, Heart, House, type Icon, Lightbulb,
  Lock, MusicNote, Newspaper, Package, PaintBrush, PawPrint, Receipt, Rocket, Scales, Sparkle, Star, Tag, Truck,
  Users, Wrench,
} from "@phosphor-icons/react";
import { createElement, type CSSProperties } from "react";
import { cn } from "@/lib/utils";

/**
 * How a label looks: one of our own Phosphor icons and one of a fixed set of colors.
 * Both are stored by name, so a label stays readable in light and dark and nobody
 * can bring in icons of their own.
 */
export const LABEL_ICONS: Record<string, Icon> = {
  tag: Tag, star: Star, heart: Heart, flag: Flag, bookmark: BookmarkSimple, fire: Fire, sparkle: Sparkle,
  bell: Bell, lightbulb: Lightbulb, rocket: Rocket, crown: Crown, lock: Lock, briefcase: Briefcase,
  buildings: Buildings, handshake: Handshake, users: Users, chat: ChatCircle, calendar: Calendar,
  receipt: Receipt, "credit-card": CreditCard, bank: Bank, chart: ChartLine, scales: Scales, package: Package,
  truck: Truck, airplane: Airplane, house: House, code: Code, bug: Bug, wrench: Wrench, newspaper: Newspaper,
  "graduation-cap": GraduationCap, "paint-brush": PaintBrush, music: MusicNote, game: GameController,
  coffee: Coffee, gift: Gift, paw: PawPrint,
};

// The swatch is the stored value; light and dark text keep it readable on either theme.
export const LABEL_COLORS = [
  { value: "gray", name: "Gray", swatch: "oklch(0.6 0.01 260)", text: "oklch(0.5 0.01 260)", textDark: "oklch(0.78 0.01 260)" },
  { value: "red", name: "Red", swatch: "oklch(0.63 0.2 25)", text: "oklch(0.55 0.2 25)", textDark: "oklch(0.75 0.15 25)" },
  { value: "orange", name: "Orange", swatch: "oklch(0.7 0.17 50)", text: "oklch(0.58 0.16 50)", textDark: "oklch(0.8 0.13 55)" },
  { value: "amber", name: "Amber", swatch: "oklch(0.8 0.16 85)", text: "oklch(0.6 0.13 75)", textDark: "oklch(0.85 0.13 85)" },
  { value: "green", name: "Green", swatch: "oklch(0.68 0.16 150)", text: "oklch(0.55 0.14 150)", textDark: "oklch(0.8 0.13 150)" },
  { value: "teal", name: "Teal", swatch: "oklch(0.7 0.12 190)", text: "oklch(0.55 0.1 195)", textDark: "oklch(0.8 0.1 190)" },
  { value: "blue", name: "Blue", swatch: "oklch(0.63 0.17 255)", text: "oklch(0.53 0.17 255)", textDark: "oklch(0.76 0.12 255)" },
  { value: "indigo", name: "Indigo", swatch: "oklch(0.58 0.19 280)", text: "oklch(0.5 0.19 280)", textDark: "oklch(0.75 0.13 280)" },
  { value: "violet", name: "Violet", swatch: "oklch(0.62 0.2 305)", text: "oklch(0.52 0.2 305)", textDark: "oklch(0.77 0.14 305)" },
  { value: "pink", name: "Pink", swatch: "oklch(0.67 0.2 350)", text: "oklch(0.56 0.2 350)", textDark: "oklch(0.78 0.14 350)" },
] as const;

export type LabelColor = (typeof LABEL_COLORS)[number]["value"];

export type LabelLook = { color?: string | null; icon?: string | null };

export const labelIcon = (icon?: string | null): Icon => (icon && LABEL_ICONS[icon]) || Tag;

const colorOf = (color?: string | null) => LABEL_COLORS.find((item) => item.value === color);

/** CSS variables for a label's color; `.label-tint` reads them so dark mode switches. */
export function labelVars(color?: string | null): CSSProperties | undefined {
  const found = colorOf(color);
  if (!found) return undefined;
  return {
    "--label-swatch": found.swatch,
    "--label-text": found.text,
    "--label-text-dark": found.textDark,
  } as CSSProperties;
}

export function LabelIcon({ label, className, weight }: { label: LabelLook; className?: string; weight?: "regular" | "fill" | "bold" }) {
  const colored = Boolean(colorOf(label.color));
  return createElement(labelIcon(label.icon), {
    "aria-hidden": true,
    weight: weight ?? (colored ? "fill" : "regular"),
    className: cn(colored && "label-tint", className),
    style: labelVars(label.color),
  });
}

/** A label's chip in the list and the reader. */
export function LabelChip({ label, size = "sm" }: { label: LabelLook & { name: string }; size?: "sm" | "default" }) {
  const colored = Boolean(colorOf(label.color));
  return (
    <span
      className={cn(
        "inline-flex max-w-32 shrink-0 items-center gap-1 rounded-sm font-medium",
        size === "sm" ? "h-4 px-1 text-[.625rem]" : "h-5 px-1.5 text-xs",
        colored ? "label-chip" : "bg-secondary text-secondary-foreground",
      )}
      style={labelVars(label.color)}
    >
      <LabelIcon label={label} className={size === "sm" ? "size-2.5 shrink-0" : "size-3 shrink-0"} />
      <span className="truncate">{label.name}</span>
    </span>
  );
}
