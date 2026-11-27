"use client";

import { useCallback, useEffect, useState } from "react";
import { PROVIDER_INFO } from "@hellobox/providers/types";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { call } from "@/core/client/api";
import { Section, useRun } from "../shared";
import { formatDay } from "./agents-tab";

export const CATEGORIES = [
  { label: "Notifications", value: "notifications" },
  { label: "Purchases", value: "purchases" },
  { label: "Newsletters", value: "newsletters" },
  { label: "Primary", value: "primary" },
] as const;

// Addresses HelloBox stopped sending to after a permanent bounce or a spam report. Each
// one says why, and admins can let mail go to it again.
export function SuppressionsTab({ admin }: { admin: boolean }) {
  const run = useRun();
  const [rows, setRows] = useState<Awaited<ReturnType<typeof call<"/suppressions/list">>>["suppressions"] | null>(null);
  const load = useCallback(() => call("/suppressions/list").then((result) => setRows(result.suppressions)), []);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <Section
      title="Suppressed addresses"
      description="When mail to an address bounces permanently, or someone marks your mail as spam, HelloBox stops sending to them: the composer warns first, and campaigns skip them. Sending to these again can hurt your sender reputation."
    >
      {rows === null ? (
        <Skeleton className="h-16 w-full" />
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing here. Addresses appear after a permanent bounce or a spam report.</p>
      ) : (
        <ul className="divide-y">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-start gap-x-3 gap-y-1.5 py-2.5 text-sm">
              <span className="min-w-0 flex-1 basis-56">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="break-all text-foreground">{row.email}</span>
                  <Badge variant={row.reason === "complaint" ? "error" : "warning"} size="sm">
                    {row.reason === "complaint" ? "Reported as spam" : "Bounced"}
                  </Badge>
                </span>
                <span className="mt-0.5 block text-muted-foreground text-xs">
                  {formatDay(row.updatedAt)}
                  {row.provider ? ` · reported by ${PROVIDER_INFO[row.provider].name}` : ""}
                  {row.campaignId ? " · from a campaign" : ""}
                  {row.detail ? ` · ${row.detail}` : ""}
                </span>
              </span>
              {admin && (
                <AlertDialog>
                  <AlertDialogTrigger render={<Button size="sm" variant="ghost" className="ms-auto" />}>Remove</AlertDialogTrigger>
                  <AlertDialogPopup>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Send to {row.email} again?</AlertDialogTitle>
                      <AlertDialogDescription>
                        {row.reason === "complaint"
                          ? "This person marked your mail as spam. Only remove it if they asked to hear from you again."
                          : "Mail to this address bounced permanently. Only remove it if you know the address works now."}{" "}
                        Your provider may keep its own block. This is recorded in the audit log.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogClose render={<Button variant="ghost" />}>Keep it</AlertDialogClose>
                      <AlertDialogClose
                        render={<Button variant="destructive" />}
                        onClick={async () => {
                          await run(() => call("/suppressions/remove", { id: row.id }), `${row.email} can get mail again`);
                          load();
                        }}
                      >
                        Remove
                      </AlertDialogClose>
                    </AlertDialogFooter>
                  </AlertDialogPopup>
                </AlertDialog>
              )}
            </li>
          ))}
        </ul>
      )}
      {!admin && rows && rows.length > 0 && (
        <p className="text-muted-foreground text-xs">Only workspace admins can remove an address.</p>
      )}
    </Section>
  );
}
