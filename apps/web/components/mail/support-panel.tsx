"use client";

import { SealCheck, WarningCircle } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ThreadDetail } from "@/core/client/api";
import { SUPPORT_STATUS_LABELS, type SupportStatus } from "./types";

const STATUSES = (Object.keys(SUPPORT_STATUS_LABELS) as SupportStatus[]).map((value) => ({ value, label: SUPPORT_STATUS_LABELS[value] }));

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="break-words text-foreground text-sm">{children}</dd>
    </div>
  );
}

/** Beside a conversation that came from an app: its status, and who the customer is. */
export function SupportPanel({ support, onStatus }: {
  support: NonNullable<ThreadDetail["support"]>;
  onStatus: (status: SupportStatus) => void;
}) {
  return (
    <aside aria-label="Support" className="mt-6 h-fit shrink-0 rounded-xl bg-muted/72 p-3 @xl:sticky @xl:top-6 @xl:w-44 @4xl:w-60 dark:bg-input/24">
      <Select value={support.status} items={STATUSES} onValueChange={(value) => { if (value) onStatus(value); }}>
        <SelectTrigger size="sm" aria-label="Status" className="w-full min-w-0 bg-background"><SelectValue /></SelectTrigger>
        <SelectPopup>{STATUSES.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectPopup>
      </Select>
      <p className="mt-3 flex items-center gap-1.5 text-xs">
        {support.verified ? (
          <><SealCheck weight="fill" className="size-4 shrink-0 text-success" /> <span className="text-foreground">Signed in to your app</span></>
        ) : (
          <><WarningCircle weight="fill" className="size-4 shrink-0 text-warning" /> <span className="text-foreground">Address not confirmed</span></>
        )}
      </p>
      {!support.verified && <p className="mt-1 text-muted-foreground text-xs">Anyone could have typed it. Don&apos;t share account details.</p>}
      <dl className="mt-3 grid max-h-40 grid-cols-2 gap-x-4 gap-y-2 overflow-y-auto @xl:max-h-none @xl:grid-cols-1">
        {support.name && <Detail label="Name">{support.name}</Detail>}
        <Detail label="Replies go to">{support.email}</Detail>
        {support.userId && <Detail label="Customer ID"><span className="font-mono text-xs">{support.userId}</span></Detail>}
        <Detail label="From">{support.inbox}</Detail>
        {Object.entries(support.metadata).map(([key, value]) => (
          <Detail key={key} label={key}>{value === null || value === "" ? "—" : String(value)}</Detail>
        ))}
      </dl>
    </aside>
  );
}
