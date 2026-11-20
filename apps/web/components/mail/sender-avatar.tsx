import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

// A stable tint per sender makes a long list easier to scan.
export function SenderAvatar({
  name, src, className, fallbackClassName,
}: { name: string; src?: string | null; className?: string; fallbackClassName?: string }) {
  const initials = name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");
  const hue = [...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360;
  return (
    <Avatar className={cn("shrink-0", className)}>
      {src && <AvatarImage src={src} alt="" />}
      <AvatarFallback
        style={{
          backgroundColor: `light-dark(oklch(0.92 0.04 ${hue}), oklch(0.32 0.05 ${hue}))`,
          color: `light-dark(oklch(0.38 0.1 ${hue}), oklch(0.88 0.06 ${hue}))`,
        }}
        className={cn("font-semibold text-xs", fallbackClassName)}
      >
        {initials || "?"}
      </AvatarFallback>
    </Avatar>
  );
}
