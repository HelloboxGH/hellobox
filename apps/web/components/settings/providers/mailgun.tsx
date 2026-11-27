"use client";

import { Warning } from "@phosphor-icons/react";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DialogFooter, DialogPanel } from "@/components/ui/dialog";
import { type Bootstrap, call } from "@/core/client/api";
import { notify } from "@/core/client/notify";
import { MailgunIcon } from "@/components/brand-icons";
import { PASTE_KEY_PROVIDERS, PasteKeyDialog } from "../connect-provider";
import { DomainList } from "../provider-domains";
import { useRun } from "../shared";
import { type Connection, DisconnectButton, ProviderRow, ServerChoice } from "./shared";

export type MailgunRegion = "us" | "eu";
const MAILGUN_REGIONS: Record<MailgunRegion, string> = { us: "US", eu: "EU" };

// Paste the API key and the signing key. The region is found from where the domains
// are; only when that's unclear does a second step ask for it.
export function MailgunConnectDialog({ open, onOpenChange, reconnectId, refresh }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reconnectId?: string;
  refresh: () => void;
}) {
  const run = useRun();
  const [keys, setKeys] = useState<{ apiKey: string; signingKey: string } | null>(null);
  const [region, setRegion] = useState<MailgunRegion>("us");
  const [busy, setBusy] = useState(false);

  function close(next: boolean) {
    if (!next) setKeys(null);
    onOpenChange(next);
  }

  async function connect(input: { apiKey: string; signingKey: string; region?: MailgunRegion }) {
    let connected = false;
    await run(async () => {
      const result = await call("/connections/mailgun/connect", { ...input, connectionId: reconnectId });
      if (result.needsRegion) {
        setKeys({ apiKey: input.apiKey, signingKey: input.signingKey });
        return;
      }
      connected = true;
    });
    if (connected) {
      notify(reconnectId ? "Mailgun is connected again" : "Mailgun is connected");
      refresh();
      close(false);
    }
  }

  const step = keys ? (
    <>
      <DialogPanel className="space-y-3">
        <p className="text-muted-foreground text-sm">
          We couldn&apos;t tell which region your Mailgun domains are in. It&apos;s shown next to each domain in Mailgun, and the API address ends in eu.mailgun.net for EU.
        </p>
        <div className="space-y-1.5">
          {(["us", "eu"] as const).map((value) => (
            <ServerChoice
              key={value}
              selected={region === value}
              onSelect={() => setRegion(value)}
              title={`${MAILGUN_REGIONS[value]} region`}
              detail={value === "us" ? "api.mailgun.net" : "api.eu.mailgun.net"}
            />
          ))}
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button variant="ghost" onClick={() => setKeys(null)}>Back</Button>
        <Button
          loading={busy}
          onClick={async () => {
            setBusy(true);
            await connect({ ...keys, region });
            setBusy(false);
          }}
        >
          Connect
        </Button>
      </DialogFooter>
    </>
  ) : undefined;

  return (
    <PasteKeyDialog
      provider={PASTE_KEY_PROVIDERS.mailgun}
      open={open}
      onOpenChange={close}
      step={step}
      onSubmit={(values) => connect({ apiKey: values.apiKey ?? "", signingKey: values.signingKey ?? "" })}
    />
  );
}

export function MailgunConnection({ connection, data, refresh, admin, onReconnect }: {
  connection: Connection;
  data: Bootstrap;
  refresh: () => void;
  admin: boolean;
  onReconnect: () => void;
}) {
  const run = useRun();

  async function setReceiving(domain: string, on: boolean) {
    return (await call("/connections/mailgun/receiving", { connectionId: connection.id, domain, on })).mx;
  }

  return (
    <div className="space-y-3 rounded-2xl border p-3">
      <ProviderRow
        icon={<MailgunIcon className="size-5 text-[#F06B66]" />}
        name="Mailgun"
        detail={connection.mailgunRegion ? `${MAILGUN_REGIONS[connection.mailgunRegion]} region` : undefined}
        status={connection.status}
      >
        {admin && connection.status === "needs_reconnect" && <Button size="sm" onClick={onReconnect}>Connect again</Button>}
        {admin && (
          <DisconnectButton
            title="Disconnect Mailgun?"
            description="New mail stops arriving and sending stops. Your existing mail stays here. We remove our routes and webhook; your domains stay in Mailgun."
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
          <AlertDescription>Mailgun stopped accepting the API key, so it was probably deleted or rotated. Connect again with a current key.</AlertDescription>
        </Alert>
      )}

      {connection.status === "active" && (
        <>
          <DomainList
            connection={connection}
            data={data}
            admin={admin}
            refresh={refresh}
            canAdd
            emptyText="No domains in this Mailgun region yet. Add one to send and receive from it."
            receiving={(domain) => ({ on: domain.receivingEnabled })}
            setReceiving={setReceiving}
          />
        </>
      )}
    </div>
  );
}
