"use client";

import { Warning } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { type Bootstrap, call } from "@/core/client/api";
import { notify, notifyInfo } from "@/core/client/notify";
import { BirdIcon, BrevoIcon, MailerSendIcon, MailjetIcon, SendGridIcon } from "@/components/brand-icons";
import { PASTE_KEY_PROVIDERS, PasteKeyDialog } from "../connect-provider";
import { type DnsSetup } from "../dns-records";
import { DomainList } from "../provider-domains";
import { useRun } from "../shared";
import { type Connection, DisconnectButton, ProviderRow } from "./shared";

type Domain = Bootstrap["domains"][number];

// Everything that differs between the providers connected by pasting a key. Adding one
// means adding an entry here, its PASTE_KEY_PROVIDERS entry and its server endpoints.
type ApiKeyProvider = {
  name: string;
  icon: ReactNode;
  // Connects, and says whether delivery events were set up (undefined: the provider has none to set up).
  connect: (values: Record<string, string>, connectionId?: string) => Promise<boolean | undefined>;
  // Without events, said once the connection is made.
  noEventsNotice?: string;
  setReceiving: (connectionId: string, domain: string, on: boolean) => Promise<DnsSetup | null>;
  detail?: (connection: Connection) => string | undefined;
  eventsMissing?: (connection: Connection) => boolean;
  eventsAlert?: ReactNode;
  disconnectDescription: string;
  keyRejected: string;
  emptyText: string;
  receiving?: (connection: Connection) => (domain: Domain) => { on: boolean; waiting?: boolean };
};

export const API_KEY_PROVIDERS = {
  sendgrid: {
    name: "SendGrid",
    icon: <SendGridIcon className="size-5" />,
    connect: async (values, connectionId) => (await call("/connections/sendgrid/connect", { apiKey: values.apiKey ?? "", connectionId })).events,
    noEventsNotice: "SendGrid is connected, without delivery events: your plan's events webhooks are all in use. Sent mail shows Sent, not Delivered.",
    setReceiving: async (connectionId, domain, on) => (await call("/connections/sendgrid/receiving", { connectionId, domain, on })).mx,
    detail: (connection) => (connection.sendgridRegion === "eu" ? "EU" : undefined),
    eventsMissing: (connection) => connection.sendgridEvents === false,
    eventsAlert: <>No delivery events: SendGrid&apos;s plan limit on events webhooks was reached. Sent mail shows Sent, not Delivered. Free one in SendGrid, then connect again.</>,
    disconnectDescription: "New mail stops arriving and sending stops. Your existing mail stays here. We remove our Inbound Parse settings and events webhook; your domains stay in SendGrid.",
    keyRejected: "SendGrid stopped accepting the API key, so it was probably deleted. Connect again with a new key.",
    emptyText: "No authenticated domains in SendGrid yet. Add one to send and receive from it.",
  },
  brevo: {
    name: "Brevo",
    icon: <BrevoIcon className="size-5" />,
    connect: async (values, connectionId) => (await call("/connections/brevo/connect", { apiKey: values.apiKey ?? "", connectionId })).events,
    noEventsNotice: "Brevo is connected, without delivery events: Brevo wouldn't add the webhook. Sent mail shows Sent, not Delivered.",
    setReceiving: async (connectionId, domain, on) => (await call("/connections/brevo/receiving", { connectionId, domain, on })).mx,
    eventsMissing: (connection) => connection.brevoEvents === false,
    eventsAlert: <>No delivery events: Brevo wouldn&apos;t add the webhook. Sent mail shows Sent, not Delivered. Connect again to retry.</>,
    disconnectDescription: "New mail stops arriving and sending stops. Your existing mail stays here. We remove our webhooks from Brevo; your domains stay there.",
    keyRejected: "Brevo stopped accepting the API key, so it was probably deleted. Connect again with a new key.",
    emptyText: "No domains in Brevo yet. Add one to send and receive from it.",
  },
  mailersend: {
    name: "MailerSend",
    icon: <MailerSendIcon className="size-5" />,
    connect: async (values, connectionId) => (await call("/connections/mailersend/connect", { apiKey: values.apiKey ?? "", connectionId })).events,
    noEventsNotice: "MailerSend is connected, but not every domain has delivery events: your plan's webhooks are all in use. Sent mail shows Sent, not Delivered.",
    setReceiving: async (connectionId, domain, on) => (await call("/connections/mailersend/receiving", { connectionId, domain, on })).mx,
    eventsMissing: (connection) => connection.mailersendEvents === false,
    eventsAlert: <>Some domains have no delivery events: MailerSend&apos;s plan limit on webhooks was reached. Their sent mail shows Sent, not Delivered.</>,
    disconnectDescription: "New mail stops arriving and sending stops. Your existing mail stays here. We remove our inbound routes and webhooks from MailerSend; your domains stay there.",
    keyRejected: "MailerSend stopped accepting the API token, so it was probably deleted. Connect again with a new token.",
    emptyText: "No domains in MailerSend yet. Add one to send and receive from it.",
  },
  mailjet: {
    name: "Mailjet",
    icon: <MailjetIcon className="size-5" />,
    connect: async (values, connectionId) =>
      (await call("/connections/mailjet/connect", { apiKey: values.apiKey ?? "", secretKey: values.secretKey ?? "", connectionId })).events,
    noEventsNotice: "Mailjet is connected, but some delivery events are missing: Mailjet already sends them to another address. Sent mail shows Sent, not Delivered.",
    setReceiving: async (connectionId, domain, on) => (await call("/connections/mailjet/receiving", { connectionId, domain, on })).mx,
    eventsMissing: (connection) => connection.mailjetEvents === false,
    eventsAlert: <>Some delivery events are missing: Mailjet already sends them to another address (it takes one per event type). Remove that one in Mailjet&apos;s Event Tracking, then connect again.</>,
    disconnectDescription: "New mail stops arriving and sending stops. Your existing mail stays here. We remove our parse routes and event callbacks from Mailjet; your domains stay there.",
    keyRejected: "Mailjet stopped accepting the keys, so they were probably deleted. Connect again with new ones.",
    emptyText: "No domains in Mailjet yet. Add one to send and receive from it.",
  },
  bird: {
    name: "Bird",
    icon: <BirdIcon className="size-5 rounded-[5px]" />,
    connect: async (values, connectionId) => {
      await call("/connections/bird/connect", { apiKey: values.apiKey ?? "", connectionId });
      return undefined;
    },
    setReceiving: async (connectionId, domain, on) => {
      const result = await call("/connections/bird/receiving", { connectionId, domain, on });
      if (result.waiting) notifyInfo(`Bird turns on receiving for ${domain} once it sees the domain's DKIM record. HelloBox keeps trying.`);
      return result.mx;
    },
    detail: (connection) => (connection.birdRegion === "eu1" ? "EU" : undefined),
    disconnectDescription: "New mail stops arriving and sending stops. Your existing mail stays here. We remove our webhook from Bird and turn off the receiving we turned on; your domains stay there.",
    keyRejected: "Bird stopped accepting the access key, so it was probably revoked. Connect again with a new key.",
    emptyText: "No domains in Bird yet. Add one to send and receive from it. Bird suggests a subdomain, like mail.example.com.",
    receiving: (connection) => {
      const pending = new Set(connection.birdPending ?? []);
      return (domain) => ({ on: domain.receivingEnabled || pending.has(domain.name), waiting: pending.has(domain.name) });
    },
  },
} satisfies Record<string, ApiKeyProvider>;

export type ApiKeyKind = keyof typeof API_KEY_PROVIDERS;

export const isApiKeyKind = (kind: string): kind is ApiKeyKind => kind in API_KEY_PROVIDERS;

export function ApiKeyConnectDialog({ kind, open, onOpenChange, reconnectId, refresh }: {
  kind: ApiKeyKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reconnectId?: string;
  refresh: () => void;
}) {
  const run = useRun();
  const provider: ApiKeyProvider = API_KEY_PROVIDERS[kind];

  async function connect(values: Record<string, string>) {
    let events: boolean | undefined;
    const done = await run(async () => {
      events = await provider.connect(values, reconnectId);
    });
    if (!done) return;
    if (events === false && provider.noEventsNotice) notifyInfo(provider.noEventsNotice);
    else notify(reconnectId ? `${provider.name} is connected again` : `${provider.name} is connected`);
    refresh();
    onOpenChange(false);
  }

  return <PasteKeyDialog provider={PASTE_KEY_PROVIDERS[kind]} open={open} onOpenChange={onOpenChange} onSubmit={connect} />;
}

export function ApiKeyConnection({ kind, connection, data, refresh, admin, onReconnect }: {
  kind: ApiKeyKind;
  connection: Connection;
  data: Bootstrap;
  refresh: () => void;
  admin: boolean;
  onReconnect: () => void;
}) {
  const run = useRun();
  const provider: ApiKeyProvider = API_KEY_PROVIDERS[kind];

  return (
    <div className="space-y-3 rounded-2xl border p-3">
      <ProviderRow icon={provider.icon} name={provider.name} detail={provider.detail?.(connection)} status={connection.status}>
        {admin && connection.status === "needs_reconnect" && <Button size="sm" onClick={onReconnect}>Connect again</Button>}
        {admin && (
          <DisconnectButton
            title={`Disconnect ${provider.name}?`}
            description={provider.disconnectDescription}
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
          <AlertDescription>{provider.keyRejected}</AlertDescription>
        </Alert>
      )}
      {connection.status === "active" && provider.eventsMissing?.(connection) && (
        <Alert variant="info" className="rounded-xl">
          <Warning />
          <AlertDescription>{provider.eventsAlert}</AlertDescription>
        </Alert>
      )}

      {connection.status === "active" && (
        <DomainList
          connection={connection}
          data={data}
          admin={admin}
          refresh={refresh}
          canAdd
          emptyText={provider.emptyText}
          receiving={provider.receiving?.(connection) ?? ((domain) => ({ on: domain.receivingEnabled }))}
          setReceiving={(domain, on) => provider.setReceiving(connection.id, domain, on)}
        />
      )}
    </div>
  );
}
