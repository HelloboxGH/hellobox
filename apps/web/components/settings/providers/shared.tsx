"use client";

import { Check } from "@phosphor-icons/react";
import { useState } from "react";
import { PROVIDER_INFO } from "@hellobox/providers/types";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { type Bootstrap } from "@/core/client/api";
import { cn } from "@/lib/utils";

export type Connection = Bootstrap["connections"][number];
// Short enough for a domain row, and tells apart the same domain on two connections.
export function connectionLabel(connection: Connection | undefined) {
  if (!connection) return "Unknown provider";
  if (connection.provider !== "ses") return PROVIDER_INFO[connection.provider].name;
  return ["Amazon SES", connection.region, connection.accountId && `account ${connection.accountId}`].filter(Boolean).join(" · ");
}

export function ProviderRow({ icon, name, detail, status, children }: {
  icon: React.ReactNode;
  name: string;
  detail?: string;
  status: Connection["status"];
  children?: React.ReactNode;
}) {
  const badge =
    status === "active" ? <Badge variant="success">Connected</Badge>
    : status === "pending" ? <Badge variant="info">Setting up</Badge>
    : <Badge variant="warning">Needs reconnecting</Badge>;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="flex min-w-0 flex-1 basis-56 items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium text-foreground text-sm">{name} {badge}</span>
          {detail && <span className="block truncate text-muted-foreground text-xs">{detail}</span>}
        </span>
      </span>
      {/* On a phone the buttons go to their own line, on the right. */}
      {children && <span className="ms-auto flex shrink-0 flex-wrap items-center justify-end gap-2">{children}</span>}
    </div>
  );
}

// Stays open while disconnecting, so the button shows it's working and can't be pressed twice.
export function DisconnectButton({ title, description, onConfirm }: { title: string; description: React.ReactNode; onConfirm: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!busy) setOpen(next); }}>
      <AlertDialogTrigger render={<Button size="sm" variant="destructive-outline" />}>Disconnect</AlertDialogTrigger>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" disabled={busy} />}>Stay connected</AlertDialogClose>
          <Button
            variant="destructive"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              await onConfirm();
              setBusy(false);
              setOpen(false);
            }}
          >
            Disconnect
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

export function ServerChoice({ selected, onSelect, title, detail }: { selected: boolean; onSelect: () => void; title: string; detail: string }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-3 rounded-xl border p-3 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
        selected && "border-brand bg-brand-soft hover:bg-brand-soft",
      )}
    >
      <span className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border", selected && "border-brand bg-brand text-brand-contrast")}>
        {selected && <Check className="size-2.5" weight="bold" />}
      </span>
      <span className="min-w-0">
        <span className="block font-medium text-foreground text-sm">{title}</span>
        <span className="block text-muted-foreground text-xs">{detail}</span>
      </span>
    </button>
  );
}
