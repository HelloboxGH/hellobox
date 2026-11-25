"use client";

import { Check, Copy } from "@phosphor-icons/react";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { notify, notifyError } from "@/core/client/notify";
import { cn } from "@/lib/utils";

export function Section({ title, description, children, tone }: { title: string; description?: string; children: ReactNode; tone?: "danger" }) {
  return (
    <Card className={cn(tone === "danger" && "border-destructive/24")}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardPanel className="space-y-3">{children}</CardPanel>
    </Card>
  );
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2000);
        } catch (error) {
          notifyError(error);
        }
      }}
    >
      {copied ? <Check /> : <Copy />}
      {copied ? "Copied" : label}
    </Button>
  );
}

export function useRun() {
  return useCallback(async (work: () => Promise<unknown>, success?: string) => {
    try {
      await work();
      if (success) notify(success);
      return true;
    } catch (error) {
      notifyError(error);
      return false;
    }
  }, []);
}

// useRun for one button: running shows its loading state, and a second press while the
// first is still going does nothing.
export function useRunning() {
  const run = useRun();
  const [running, setRunning] = useState(false);
  const busy = useRef(false);
  const start = useCallback(async (work: () => Promise<unknown>, success?: string) => {
    if (busy.current) return false;
    busy.current = true;
    setRunning(true);
    try {
      return await run(work, success);
    } finally {
      busy.current = false;
      setRunning(false);
    }
  }, [run]);
  return [running, start] as const;
}
