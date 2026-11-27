"use client";

import { Warning } from "@phosphor-icons/react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { type Bootstrap, call } from "@/core/client/api";
import { CloudflareIcon, ResendIcon } from "@/components/brand-icons";
import { DomainList } from "../provider-domains";
import { useRun } from "../shared";
import { type Connection, DisconnectButton, ProviderRow } from "./shared";

export function ResendConnection({ connection, data, refresh, admin, connectHref }: {
  connection: Connection;
  data: Bootstrap;
  refresh: () => void;
  admin: boolean;
  connectHref: string;
}) {
  const run = useRun();
  return (
    <div className="space-y-3 rounded-2xl border p-3">
      <ProviderRow icon={<ResendIcon className="size-4 text-foreground" />} name="Resend" detail="Domains, receiving and delivery events come from your Resend account" status={connection.status}>
        {connection.status !== "active" && <Button size="sm" render={<a href={connectHref} />}>Reconnect</Button>}
        {admin && (
          <DisconnectButton
            title="Disconnect Resend?"
            description="New mail stops arriving, and sending stops too. Your existing mail stays here."
            onConfirm={async () => {
              await run(() => call("/connections/disconnect", { id: connection.id }), "Disconnected");
              refresh();
            }}
          />
        )}
      </ProviderRow>
      {connection.status === "needs_reconnect" && (
        <Alert variant="warning" className="rounded-xl">
          <Warning />
          <AlertDescription>HelloBox&apos;s access to your Resend account expired or was removed. Reconnect to pick up where you left off. Mail that arrived meanwhile catches up.</AlertDescription>
        </Alert>
      )}
      {connection.status === "active" && (
        <DomainList
          connection={connection}
          data={data}
          admin={admin}
          refresh={refresh}
          canAdd
          emptyText="No domains in this Resend account yet. Add one to start."
          receiving={(domain) => ({ on: domain.receivingEnabled })}
        />
      )}
    </div>
  );
}

// Domain records are added from each domain's DNS dialog. This only shows the grant.
export function CloudflareConnection({ refresh, admin }: { refresh: () => void; admin: boolean }) {
  const run = useRun();
  return (
    <div className="rounded-2xl border p-3">
      <ProviderRow icon={<CloudflareIcon className="size-4 text-[#F38020]" />} name="Cloudflare" detail="Adds DNS records for domains hosted on Cloudflare" status="active">
        {admin && (
          <DisconnectButton
            title="Disconnect Cloudflare?"
            description="Records already added stay in your zones. New domains need their records added by hand, or Cloudflare connected again."
            onConfirm={async () => {
              await run(() => call("/connections/cloudflare/disconnect", {}), "Cloudflare disconnected");
              refresh();
            }}
          />
        )}
      </ProviderRow>
    </div>
  );
}
