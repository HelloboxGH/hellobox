"use client";

import { ImageSquare } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { notify, notifyError } from "@/core/client/notify";
import { removeWorkspaceLogo, uploadWorkspaceLogo } from "@/core/client/workspace-logo";
import { cn } from "@/lib/utils";

/** A workspace's logo, or its initials on a tint picked from the name. */
export function WorkspaceMark({ name, logo, className }: { name: string; logo: string | null; className?: string }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");
  const hue = [...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360;
  return (
    <Avatar className={cn("size-8 shrink-0 rounded-lg", className)}>
      {logo && <AvatarImage src={logo} alt="" className="rounded-[inherit]" />}
      <AvatarFallback
        className="rounded-[inherit] font-semibold text-xs"
        style={{
          backgroundColor: `light-dark(oklch(0.92 0.04 ${hue}), oklch(0.32 0.05 ${hue}))`,
          color: `light-dark(oklch(0.38 0.1 ${hue}), oklch(0.88 0.06 ${hue}))`,
        }}
      >
        {initials || "?"}
      </AvatarFallback>
    </Avatar>
  );
}

/** Upload, change or remove the logo. Admins only; the server checks too. */
export function WorkspaceLogoPicker({ name, logo, onChanged }: { name: string; logo: string | null; onChanged: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  async function change(work: () => Promise<unknown>, success: string) {
    setBusy(true);
    try {
      await work();
      notify(success);
      onChanged();
    } catch (error) {
      notifyError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-3">
      <WorkspaceMark name={name || "Workspace"} logo={logo} className="size-14 rounded-xl" />
      <p className="min-w-40 flex-1 text-muted-foreground text-sm">A square PNG, JPEG or WebP works best.</p>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        aria-label="Workspace logo"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void change(() => uploadWorkspaceLogo(file), "Logo updated");
        }}
      />
      <div className="flex gap-2">
        <Button type="button" size="sm" variant="outline" loading={busy} onClick={() => input.current?.click()}>
          <ImageSquare /> {logo ? "Change logo" : "Upload logo"}
        </Button>
        {logo && (
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => change(removeWorkspaceLogo, "Logo removed")}>
            Remove
          </Button>
        )}
      </div>
    </div>
  );
}
