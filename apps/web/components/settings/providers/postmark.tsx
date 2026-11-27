"use client";

import { Warning } from "@phosphor-icons/react";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DialogFooter, DialogPanel } from "@/components/ui/dialog";
import { type Bootstrap, call } from "@/core/client/api";
import { notifyInfo } from "@/core/client/notify";
import { PostmarkIcon } from "@/components/brand-icons";
import { PASTE_KEY_PROVIDERS, PasteKeyDialog } from "../connect-provider";
import { DomainList } from "../provider-domains";
import { useRun } from "../shared";
import { type Connection, DisconnectButton, ProviderRow, ServerChoice } from "./shared";

type PostmarkServerChoice = { id: number; name: string; inboundDomain: string | null; hasOtherHook: boolean };

// Paste the account token, then pick a server: ours by default, or one that exists.
export function PostmarkConnectDialog({ open, onOpenChange, reconnectId, refresh }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reconnectId?: string;
  refresh: () => void;
}) {
  const run = useRun();
  const [token, setToken] = useState<string | null>(null);
  const [servers, setServers] = useState<PostmarkServerChoice[]>([]);
  const [choice, setChoice] = useState<number | "new">("new");
  const [busy, setBusy] = useState(false);

  function close(next: boolean) {
    if (!next) {
      setToken(null);
      setServers([]);
      setChoice("new");
    }
    onOpenChange(next);
  }

  async function connect() {
    if (!token) return;
    setBusy(true);
    const ok = await run(
      () => call("/connections/postmark/connect", { token, server: choice, connectionId: reconnectId }),
      reconnectId ? "Postmark is connected again" : "Postmark is connected",
    );
    setBusy(false);
    if (ok) {
      refresh();
      close(false);
    }
  }

  const chosen = choice === "new" ? null : servers.find((server) => server.id === choice);
  const step = token ? (
    <>
      <DialogPanel className="space-y-1.5">
        <p className="pb-1 text-muted-foreground text-sm">Pick the Postmark server HelloBox sends and receives through.</p>
        <ServerChoice
          selected={choice === "new"}
          onSelect={() => setChoice("new")}
          title="Create a HelloBox server"
          detail="Recommended. Keeps HelloBox's mail apart from your app's, with its own stats."
        />
        {servers.map((server) => (
          <ServerChoice
            key={server.id}
            selected={choice === server.id}
            onSelect={() => setChoice(server.id)}
            title={server.name}
            detail={server.inboundDomain ? `Receives mail for ${server.inboundDomain}` : "Doesn't receive mail yet"}
          />
        ))}
        {chosen?.hasOtherHook && (
          <Alert variant="warning" className="mt-2 rounded-xl">
            <Warning />
            <AlertDescription>
              This server already sends its incoming mail to another webhook. Connecting points it at HelloBox instead, so that webhook stops getting mail.
            </AlertDescription>
          </Alert>
        )}
      </DialogPanel>
      <DialogFooter>
        <Button variant="ghost" onClick={() => setToken(null)}>Back</Button>
        <Button loading={busy} onClick={connect}>Connect</Button>
      </DialogFooter>
    </>
  ) : undefined;

  return (
    <PasteKeyDialog
      provider={PASTE_KEY_PROVIDERS.postmark}
      open={open}
      onOpenChange={close}
      step={step}
      onSubmit={async (values) => {
        await run(async () => {
          const result = await call("/connections/postmark/servers", { token: values.token ?? "" });
          setServers(result.servers);
          setChoice("new");
          setToken(values.token ?? "");
        });
      }}
    />
  );
}

export function PostmarkConnection({ connection, data, refresh, admin, onReconnect }: {
  connection: Connection;
  data: Bootstrap;
  refresh: () => void;
  admin: boolean;
  onReconnect: () => void;
}) {
  const run = useRun();
  const receivingOn = connection.inboundDomain ?? connection.pendingInboundDomain;

  async function setReceiving(domain: string, on: boolean) {
    const result = await call("/connections/postmark/receiving", { connectionId: connection.id, domain: on ? domain : null });
    if (result.waiting) notifyInfo(`The MX record for ${domain} is in place. Postmark starts receiving once it sees it, and HelloBox asks again every minute.`);
    return result.mx;
  }

  return (
    <div className="space-y-3 rounded-2xl border p-3">
      <ProviderRow
        icon={<PostmarkIcon className="size-5" />}
        name="Postmark"
        detail={connection.serverName ? `Server ${connection.serverName}` : undefined}
        status={connection.status}
      >
        {admin && connection.status === "needs_reconnect" && <Button size="sm" onClick={onReconnect}>Connect again</Button>}
        {admin && (
          <DisconnectButton
            title="Disconnect Postmark?"
            description="New mail stops arriving and sending stops. Your existing mail stays here. The server and its domains stay in your Postmark account."
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
          <AlertDescription>Postmark stopped accepting the token, so it was probably removed. Connect again with a new Account API token.</AlertDescription>
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
            emptyText="No domains in this Postmark account yet. Add one to send and receive from it."
            receiving={(domain) => ({
              on: connection.inboundDomain === domain.name,
              waiting: connection.pendingInboundDomain === domain.name,
              // A Postmark server receives for one domain at a time.
              blocked: receivingOn && receivingOn !== domain.name
                ? `A Postmark server receives for one domain. Turn ${receivingOn} off first.`
                : undefined,
            })}
            setReceiving={setReceiving}
          >
            {receivingOn && (
              <p className="px-1 text-muted-foreground text-xs">
                Postmark receives mail for one domain per server, here {receivingOn}. To receive for another, turn this one off first.
              </p>
            )}
          </DomainList>
        </>
      )}
    </div>
  );
}
