"use client";

import type { ReactNode } from "react";
import { ToastProvider } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { clientExtensions } from "@/core/client/extensions";

// Cloud wraps the app with its own providers, like the upgrade dialogs.
const { AppProviders: CloudProviders } = clientExtensions;

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <TooltipProvider delay={350}>
        {CloudProviders ? <CloudProviders>{children}</CloudProviders> : children}
      </TooltipProvider>
    </ToastProvider>
  );
}
