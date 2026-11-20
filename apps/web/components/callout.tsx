import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// HelloBox's notice: a soft, borderless panel like the upgrade prompt and the provider
// steps, not a bordered status box. Brand for guidance, a quiet neutral for information,
// and warning only when something is at stake. Actions wrap under the text when narrow.
const TONES = {
  brand: { surface: "bg-brand-soft", icon: "text-brand-foreground", title: "text-brand-foreground" },
  neutral: { surface: "bg-muted/72 dark:bg-input/24", icon: "text-muted-foreground", title: "text-foreground" },
  warning: { surface: "bg-warning/8 dark:bg-warning/12", icon: "text-warning", title: "text-foreground" },
} as const;

export function Callout({
  tone = "neutral",
  icon,
  title,
  children,
  actions,
  className,
}: {
  tone?: keyof typeof TONES;
  icon: ReactNode;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  const colors = TONES[tone];
  return (
    <div
      role={tone === "warning" ? "alert" : "status"}
      className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl p-3 text-sm", colors.surface, className)}
    >
      <div className={cn("flex min-w-0 flex-[1_1_14rem] gap-3", title ? "items-start" : "items-center")}>
        <span className={cn("flex shrink-0 [&>svg]:size-5", title && "pt-px", colors.icon)}>{icon}</span>
        <div className="min-w-0 space-y-0.5">
          {title && <p className={cn("font-medium text-sm", colors.title)}>{title}</p>}
          {children && <div className={cn(title ? "text-muted-foreground text-xs" : "text-foreground/85 text-sm")}>{children}</div>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap gap-1.5 max-sm:ps-8">{actions}</div>}
    </div>
  );
}
