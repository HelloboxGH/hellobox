"use client";

import { EnvelopeSimple, Warning } from "@phosphor-icons/react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { type Bootstrap, call } from "@/core/client/api";
import { notify } from "@/core/client/notify";
import { PASTE_KEY_PROVIDERS, PasteKeyDialog } from "../connect-provider";
import { DomainList } from "../provider-domains";
import { useRun } from "../shared";
import { type Connection, DisconnectButton, ProviderRow } from "./shared";

export function SmtpConnectDialog({ open, onOpenChange, reconnectId, refresh }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reconnectId?: string;
  refresh: () => void;
}) {
  const run = useRun();

  async function connect(values: Record<string, string>) {
    const done = await run(() =>
      call("/connections/smtp/connect", {
        host: values.host ?? "",
        port: Number(values.port) as 465 | 587 | 2525 | 25,
        username: values.username ?? "",
        password: values.password ?? "",
        connectionId: reconnectId,
      }),
    );
    if (!done) return;
    notify(reconnectId ? "SMTP is connected again" : "SMTP is connected. Add the domains you send from.");
    refresh();
    onOpenChange(false);
  }

  return <PasteKeyDialog provider={PASTE_KEY_PROVIDERS.smtp} open={open} onOpenChange={onOpenChange} onSubmit={connect} />;
}

// SMTP only sends: its domains are the ones added here, and each receives with HelloBox.
export function SmtpConnection({ connection, data, refresh, admin, onReconnect }: {
  connection: Connection;
  data: Bootstrap;
  refresh: () => void;
  admin: boolean;
  onReconnect: () => void;
}) {
  const run = useRun();

  return (
    <div className="space-y-3 rounded-2xl border p-3">
      <ProviderRow
        icon={<EnvelopeSimple className="size-5 text-muted-foreground" />}
        name="SMTP"
        detail={connection.smtpHost ?? undefined}
        status={connection.status}
      >
        {admin && connection.status === "needs_reconnect" && <Button size="sm" onClick={onReconnect}>Connect again</Button>}
        {admin && (
          <DisconnectButton
            title="Disconnect SMTP?"
            description="Sending through this server stops. Your existing mail stays here."
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
          <AlertDescription>The server stopped accepting the username or password. Connect again with the current ones.</AlertDescription>
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
