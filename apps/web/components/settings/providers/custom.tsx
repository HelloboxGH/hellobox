"use client";

import { Code, Warning } from "@phosphor-icons/react";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { type Bootstrap, call } from "@/core/client/api";
import { clientExtensions } from "@/core/client/extensions";
import { CopyValue } from "../dns-records";
import { DomainList } from "../provider-domains";
import { useRun } from "../shared";
import { type Connection, DisconnectButton, ProviderRow } from "./shared";

const { CustomProviderPanel } = clientExtensions;
// Like SMTP: it only sends, and its domains receive with HelloBox.
export function CustomConnection({ connection, data, refresh, admin, onEdit }: {
  connection: Connection;
  data: Bootstrap;
  refresh: () => void;
  admin: boolean;
  // Opens the editor with the saved spec and how it looks.
  onEdit: (saved: { spec: Record<string, unknown> | null; description: string | null; logo: string | null }) => void;
}) {
  const run = useRun();
  const name = connection.customName ?? "Custom provider";
  const [webhookUrl, setWebhookUrl] = useState<string | null>(null);

  async function edit() {
    await run(async () => onEdit(await call("/connections/custom/details", { connectionId: connection.id })));
  }

  async function showWebhook() {
    await run(async () => setWebhookUrl((await call("/connections/custom/details", { connectionId: connection.id })).webhookUrl));
  }

  return (
    <div className="space-y-3 rounded-2xl border p-3">
      <ProviderRow
        // eslint-disable-next-line @next/next/no-img-element -- our own small file
        icon={connection.customLogo ? <img src={connection.customLogo} alt="" className="size-9 rounded-xl object-cover" /> : <Code className="size-5 text-muted-foreground" />}
        name={name}
        detail={connection.customDescription ?? "Custom provider"}
        status={connection.status}
      >
        {admin && <Button size="sm" variant={connection.status === "needs_reconnect" ? "default" : "outline"} onClick={edit}>{connection.status === "needs_reconnect" ? "Connect again" : "Edit"}</Button>}
        {admin && (
          <DisconnectButton
            title={`Disconnect ${name}?`}
            description="Sending through it stops. Your existing mail stays here."
            onConfirm={async () => {
              await run(() => call("/connections/disconnect", { id: connection.id }), "Disconnected");
              refresh();
            }}
          />
        )}
      </ProviderRow>

      {admin && connection.status === "active" && connection.customEvents && (
        <div className="space-y-1.5 rounded-xl bg-muted/50 p-3 text-sm">
          <p className="font-medium">Delivery events</p>
          <p className="text-muted-foreground text-xs">Paste this address into your provider&apos;s webhook settings, so sent mail shows Delivered, Bounced or Complained.</p>
          {webhookUrl ? (
            <div className="flex items-center gap-1">
              <code className="min-w-0 flex-1 truncate rounded-md bg-background px-2 py-1 font-mono text-xs">{webhookUrl}</code>
              <CopyValue value={webhookUrl} />
            </div>
          ) : (
            <Button size="sm" variant="outline" onClick={showWebhook}>Show the address</Button>
          )}
        </div>
      )}

      {CustomProviderPanel && <CustomProviderPanel data={data} connectionId={connection.id} admin={admin} refresh={refresh} />}

      {connection.status === "needs_reconnect" && (
        <Alert variant="warning" className="rounded-xl">
          <Warning />
          <AlertDescription>Sending through it is paused, usually because the provider stopped accepting your values (it answered 401 or 403). Connect again with the current ones.</AlertDescription>
        </Alert>
      )}

      {connection.status === "active" && (
        <DomainList
          connection={connection}
          data={data}
          admin={admin}
          refresh={refresh}
          canAdd
          emptyText="Add the domains you send from. Each one then receives with HelloBox."
          receiving={() => ({ on: false })}
        />
      )}
    </div>
  );
}
