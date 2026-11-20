"use client";

import type { ComponentProps, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";

export function IconAction({
  label, shortcut, children, ...props
}: ComponentProps<typeof Button> & { label: string; shortcut?: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button aria-label={label} size="icon-sm" variant="ghost" {...props} />}>
        {children}
      </TooltipTrigger>
      <TooltipPopup className="flex items-center gap-2">
        {label}
        {shortcut && <Kbd>{shortcut}</Kbd>}
      </TooltipPopup>
    </Tooltip>
  );
}
