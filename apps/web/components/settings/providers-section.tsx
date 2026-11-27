"use client";

import { Check, Plus, Warning } from "@phosphor-icons/react";
import { useState } from "react";
import { type ProviderKind } from "@hellobox/providers/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { type Bootstrap } from "@/core/client/api";
import { useSearchParam } from "@/core/client/use-search-param";
import { track } from "@/core/client/analytics";
import { clientExtensions } from "@/core/client/extensions";
import { ISSUES_URL } from "@/core/links";
import { type ProviderAvailability, ProviderPicker } from "./connect-provider";
import { CustomConnectDialog } from "./custom-provider";
import { ApiKeyConnectDialog, ApiKeyConnection, isApiKeyKind, type ApiKeyKind } from "./providers/api-key";
import { CustomConnection } from "./providers/custom";
import { MailgunConnectDialog, MailgunConnection } from "./providers/mailgun";
import { PostmarkConnectDialog, PostmarkConnection } from "./providers/postmark";
import { CloudflareConnection, ResendConnection } from "./providers/resend";
import { SesConnectDialog, SesConnection } from "./providers/ses";
import { SmtpConnectDialog, SmtpConnection } from "./providers/smtp";

const { ProviderRequestDialog } = clientExtensions;
// The directory's listings, on a hosted build. Fixed at load, so the hook order never changes.
const noTiles = () => ({ tiles: [], dialogs: null });
const useProviderTiles = clientExtensions.useProviderTiles ?? noTiles;

export function ProvidersSection({ data, refresh, admin }: { data: Bootstrap; refresh: () => void; admin: boolean }) {
  const active = data.connections.filter((c) => c.status !== "disconnected");
  const hasResend = active.some((c) => c.provider === "resend");
  const requested = useSearchParam("connect");
  const cloudflare = useSearchParam("cloudflare");
  const [connecting, setConnecting] = useState(requested === "ses" && admin && data.providers.ses);
  const directory = useProviderTiles({ data, refresh, admin });
  // Postmark connects here, or reconnects the connection named in the link.
  const [postmark, setPostmark] = useState<{ reconnectId?: string } | null>(() => {
    if (requested !== "postmark" || !admin) return null;
    const broken = data.connections.find((c) => c.provider === "postmark" && c.status === "needs_reconnect");
    return { reconnectId: broken?.id };
  });
  const [mailgun, setMailgun] = useState<{ reconnectId?: string } | null>(() => {
    if (requested !== "mailgun" || !admin) return null;
    const broken = data.connections.find((c) => c.provider === "mailgun" && c.status === "needs_reconnect");
    return { reconnectId: broken?.id };
  });
  const [apiKey, setApiKey] = useState<{ kind: ApiKeyKind; reconnectId?: string; open: boolean } | null>(() => {
    if (!requested || !isApiKeyKind(requested) || !admin) return null;
    const broken = data.connections.find((c) => c.provider === requested && c.status === "needs_reconnect");
    return { kind: requested, reconnectId: broken?.id, open: true };
  });
  const [smtp, setSmtp] = useState<{ reconnectId?: string } | null>(() => {
    if (requested !== "smtp" || !admin) return null;
    const broken = data.connections.find((c) => c.provider === "smtp" && c.status === "needs_reconnect");
    return { reconnectId: broken?.id };
  });
  const [custom, setCustom] = useState<{ reconnectId?: string; spec?: Record<string, unknown> | null; description?: string | null; logo?: string | null } | null>(() => {
    if (requested !== "custom" || !admin) return null;
    const broken = data.connections.find((c) => c.provider === "custom" && c.status === "needs_reconnect");
    return { reconnectId: broken?.id };
  });
  const [picking, setPicking] = useState(false);
  const [requesting, setRequesting] = useState<{ provider?: string } | null>(null);
  const connectHref = `/api/resend/oauth/start?workspace=${data.workspace.id}`;
  const availability: ProviderAvailability = {
    ses: data.providers.ses ? "ready" : "hidden",
    resend: hasResend ? "connected" : "ready",
    postmark: "ready",
    mailgun: "ready",
    demo: "hidden",
    // Offered as each one is built (plans/PROVIDERS.md).
    // Its domains receive with HelloBox, so only where this HelloBox runs a mail server.
    smtp: data.helloboxMx ? "ready" : "hidden",
    sendgrid: "ready",
    brevo: "ready",
    mailersend: "ready",
    mailjet: "ready",
    bird: "ready",
    // Only sends, like SMTP.
    custom: data.helloboxMx ? "ready" : "hidden",
  };

  function pick(kind: ProviderKind) {
    setPicking(false);
    if (kind === "ses") setConnecting(true);
    else if (kind === "postmark") setPostmark({});
    else if (kind === "mailgun") setMailgun({});
    else if (isApiKeyKind(kind)) setApiKey({ kind, open: true });
    else if (kind === "smtp") setSmtp({});
    else if (kind === "custom") setCustom({});
    // An API route that redirects to Resend, so a full page load.
    else if (kind === "resend") window.location.assign(new URL(connectHref, window.location.origin));
  }

  return (
    <div className="space-y-3">
      {cloudflare === "connected" && (
        <Alert variant="success" className="rounded-xl"><Check /><AlertDescription>Cloudflare is connected. Use Add DNS records on any domain hosted there.</AlertDescription></Alert>
      )}
      {cloudflare && cloudflare !== "connected" && (
        <Alert variant="warning" className="rounded-xl"><Warning /><AlertDescription>Cloudflare wasn&apos;t connected. Try again from a domain&apos;s DNS records.</AlertDescription></Alert>
      )}
      {active.length === 0 && (
        <p className="text-muted-foreground text-sm">
          Connect the service you send email with. HelloBox reads and sends your mail through it, so nothing changes about where your mail goes.
        </p>
      )}
      {active.map((connection) =>
        connection.provider === "ses" ? (
          <SesConnection
            key={connection.id}
            connection={connection}
            data={data}
            refresh={refresh}
            admin={admin}
            onReconnect={() => setConnecting(true)}
          />
        ) : connection.provider === "postmark" ? (
          <PostmarkConnection
            key={connection.id}
            connection={connection}
            data={data}
            refresh={refresh}
            admin={admin}
            onReconnect={() => setPostmark({ reconnectId: connection.id })}
          />
        ) : connection.provider === "mailgun" ? (
          <MailgunConnection
            key={connection.id}
            connection={connection}
            data={data}
            refresh={refresh}
            admin={admin}
            onReconnect={() => setMailgun({ reconnectId: connection.id })}
          />
        ) : isApiKeyKind(connection.provider) ? (
          <ApiKeyConnection
            key={connection.id}
            kind={connection.provider}
            connection={connection}
            data={data}
            refresh={refresh}
            admin={admin}
            onReconnect={() => setApiKey({ kind: connection.provider as ApiKeyKind, reconnectId: connection.id, open: true })}
          />
        ) : connection.provider === "smtp" ? (
          <SmtpConnection
            key={connection.id}
            connection={connection}
            data={data}
            refresh={refresh}
            admin={admin}
            onReconnect={() => setSmtp({ reconnectId: connection.id })}
          />
        ) : connection.provider === "custom" ? (
          <CustomConnection
            key={connection.id}
            connection={connection}
            data={data}
            refresh={refresh}
            admin={admin}
            onEdit={(saved) => setCustom({ reconnectId: connection.id, ...saved })}
          />
        ) : connection.provider === "resend" ? (
          <ResendConnection key={connection.id} connection={connection} data={data} refresh={refresh} admin={admin} connectHref={connectHref} />
        ) : null,
      )}
      {data.dnsHosts.cloudflare && <CloudflareConnection refresh={refresh} admin={admin} />}
      {admin && (
        <div className="flex flex-wrap gap-2 pt-1">
          <Button onClick={() => setPicking(true)}><Plus /> Connect a provider</Button>
        </div>
      )}
      <ProviderPicker
        open={picking}
        onOpenChange={setPicking}
        availability={availability}
        onPick={pick}
        tiles={directory.tiles}
        onRequest={(provider) => {
          setPicking(false);
          track("Provider request opened", { from: "connect" });
          // A hosted build collects requests itself; an open instance points to its issue tracker.
          if (ProviderRequestDialog) setRequesting({ provider });
          else window.open(ISSUES_URL, "_blank", "noopener");
        }}
      />
      {directory.dialogs}
      {ProviderRequestDialog && <ProviderRequestDialog
        open={requesting !== null}
        onOpenChange={(open) => !open && setRequesting(null)}
        source="app"
        signedIn
        initialProvider={requesting?.provider}
      />}
      {data.providers.ses && (
        <SesConnectDialog open={connecting} onOpenChange={setConnecting} data={data} refresh={refresh} />
      )}
      <PostmarkConnectDialog
        open={postmark !== null}
        reconnectId={postmark?.reconnectId}
        onOpenChange={(open) => !open && setPostmark(null)}
        refresh={refresh}
      />
      <MailgunConnectDialog
        open={mailgun !== null}
        reconnectId={mailgun?.reconnectId}
        onOpenChange={(open) => !open && setMailgun(null)}
        refresh={refresh}
      />
      {apiKey && (
        <ApiKeyConnectDialog
          key={apiKey.kind}
          kind={apiKey.kind}
          open={apiKey.open}
          reconnectId={apiKey.reconnectId}
          onOpenChange={(open) => !open && setApiKey({ ...apiKey, open: false })}
          refresh={refresh}
        />
      )}
      <CustomConnectDialog
        key={custom?.reconnectId ?? "new"}
        open={custom !== null}
        reconnectId={custom?.reconnectId}
        initialSpec={custom?.spec ?? undefined}
        initialAppearance={custom ? { description: custom.description ?? null, logo: custom.logo ?? null } : undefined}
        onOpenChange={(open) => !open && setCustom(null)}
        refresh={refresh}
      />
      <SmtpConnectDialog
        open={smtp !== null}
        reconnectId={smtp?.reconnectId}
        onOpenChange={(open) => !open && setSmtp(null)}
        refresh={refresh}
      />
    </div>
  );
}
