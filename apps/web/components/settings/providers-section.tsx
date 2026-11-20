"use client";

import { ArrowSquareOut, Check, HourglassMedium, Plus, Warning } from "@phosphor-icons/react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { SES_REGIONS, stackConsoleUrl, type SesRegion } from "@hellobox/providers/connect";
import { PROVIDER_INFO, type ProviderKind } from "@hellobox/providers/types";
import {
  AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup,
  AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { type Bootstrap, call } from "@/core/client/api";
import { notify, notifyInfo } from "@/core/client/notify";
import { useSearchParam } from "@/core/client/use-search-param";
import { AmazonSesIcon, CloudflareIcon, MailgunIcon, PostmarkIcon, ResendIcon } from "@/components/brand-icons";
import { track } from "@/core/client/analytics";
import { clientExtensions } from "@/core/client/extensions";
import { ISSUES_URL } from "@/core/links";
import { cn } from "@/lib/utils";
import { PASTE_KEY_PROVIDERS, PasteKeyDialog, type ProviderAvailability, ProviderPicker } from "./connect-provider";
import { CopyValue } from "./dns-records";
import { DomainList } from "./provider-domains";
import { useRun, useRunning } from "./shared";

type Connection = Bootstrap["connections"][number];
type AccountStatus = {
  productionAccess: boolean;
  sendingEnabled: boolean;
  maxSendRate: number;
  max24HourSend: number;
  sentLast24Hours: number;
  reviewStatus: string | null;
};
const REGION_ITEMS = SES_REGIONS.map((region) => ({ label: `${region.name} · ${region.id}`, value: region.id }));

// A sensible default from the browser's time zone. People can always pick another.
function guessRegion(): SesRegion {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  if (zone.startsWith("Europe/")) return zone === "Europe/London" ? "eu-west-2" : "eu-west-1";
  if (zone.startsWith("Africa/")) return "af-south-1";
  if (zone.startsWith("Australia/")) return "ap-southeast-2";
  if (["Asia/Tokyo"].includes(zone)) return "ap-northeast-1";
  if (["Asia/Seoul"].includes(zone)) return "ap-northeast-2";
  if (["Asia/Kolkata", "Asia/Calcutta"].includes(zone)) return "ap-south-1";
  if (zone.startsWith("Asia/")) return "ap-southeast-1";
  if (zone.startsWith("America/Sao_Paulo")) return "sa-east-1";
  if (["America/Los_Angeles", "America/Vancouver"].includes(zone)) return "us-west-2";
  return "us-east-1";
}

const regionName = (id: string | null) => SES_REGIONS.find((region) => region.id === id)?.name ?? id ?? "";

// Short enough for a domain row, and tells apart the same domain on two connections.
const { ProviderRequestDialog } = clientExtensions;

export function connectionLabel(connection: Connection | undefined) {
  if (!connection) return "Unknown provider";
  if (connection.provider !== "ses") return PROVIDER_INFO[connection.provider].name;
  return ["Amazon SES", connection.region, connection.accountId && `account ${connection.accountId}`].filter(Boolean).join(" · ");
}

export function ProvidersSection({ data, refresh, admin }: { data: Bootstrap; refresh: () => void; admin: boolean }) {
  const active = data.connections.filter((c) => c.status !== "disconnected");
  const hasResend = active.some((c) => c.provider === "resend");
  const requested = useSearchParam("connect");
  const cloudflare = useSearchParam("cloudflare");
  const [connecting, setConnecting] = useState(requested === "ses" && admin && data.providers.ses);
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
  const [picking, setPicking] = useState(false);
  const [requesting, setRequesting] = useState<{ provider?: string } | null>(null);
  const connectHref = `/api/resend/oauth/start?workspace=${data.workspace.id}`;
  const availability: ProviderAvailability = {
    ses: data.providers.ses ? "ready" : "hidden",
    resend: hasResend ? "connected" : "ready",
    postmark: "ready",
    mailgun: "ready",
    demo: "hidden",
  };

  function pick(kind: ProviderKind) {
    setPicking(false);
    if (kind === "ses") setConnecting(true);
    else if (kind === "postmark") setPostmark({});
    else if (kind === "mailgun") setMailgun({});
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
        onRequest={(provider) => {
          setPicking(false);
          track("Provider request opened", { from: "connect" });
          // A hosted build collects requests itself; an open instance points to its issue tracker.
          if (ProviderRequestDialog) setRequesting({ provider });
          else window.open(ISSUES_URL, "_blank", "noopener");
        }}
      />
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
    </div>
  );
}

function ProviderRow({ icon, name, detail, status, children }: {
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

function ResendConnection({ connection, data, refresh, admin, connectHref }: {
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
        // Domains and their receiving are managed in Resend, apart from receiving on a subdomain.
        <DomainList
          connection={connection}
          data={data}
          admin={admin}
          refresh={refresh}
          canAdd={false}
          emptyText="No domains in this Resend account yet. Add one in Resend, then refresh."
          receiving={(domain) => ({ on: domain.receivingEnabled })}
        />
      )}
    </div>
  );
}

// Domain records are added from each domain's DNS dialog. This only shows the grant.
function CloudflareConnection({ refresh, admin }: { refresh: () => void; admin: boolean }) {
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

// Stays open while disconnecting, so the button shows it's working and can't be pressed twice.
function DisconnectButton({ title, description, onConfirm }: { title: string; description: React.ReactNode; onConfirm: () => Promise<void> }) {
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

function SesConnectDialog({ open, onOpenChange, data, refresh }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: Bootstrap;
  refresh: () => void;
}) {
  const [starting, runStart] = useRunning();
  const [region, setRegion] = useState<SesRegion>(() => guessRegion());
  const [route53, setRoute53] = useState(true);
  const [started, setStarted] = useState<{ connectionId: string; url: string } | null>(null);
  const connection = started && data.connections.find((c) => c.id === started.connectionId);

  // The stack reports in from AWS, so this checks back until the connection is live.
  useEffect(() => {
    if (!open || !started || connection?.status === "active") return;
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [open, started, connection?.status, refresh]);

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (starting) return;
    // Opened before the request finishes, so the browser treats it as a click and allows it.
    const tab = window.open("about:blank", "_blank");
    const ok = await runStart(async () => {
      const result = await call("/connections/ses/start", { region, route53 });
      setStarted(result);
      if (tab) tab.location.href = result.url;
      else window.location.href = result.url;
    });
    if (!ok) tab?.close();
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) setStarted(null); onOpenChange(next); }}>
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Connect Amazon SES</DialogTitle>
          <DialogDescription>
            AWS opens in a new tab with everything filled in. Tick the box at the bottom and press Create stack. That&apos;s it.
          </DialogDescription>
        </DialogHeader>
        {!started ? (
          <Form className="contents" onSubmit={start}>
            <DialogPanel className="space-y-4">
              <Field>
                <FieldLabel>Region</FieldLabel>
                <Select value={region} items={REGION_ITEMS} onValueChange={(value) => { if (value) setRegion(value as SesRegion); }}>
                  <SelectTrigger aria-label="Region"><SelectValue /></SelectTrigger>
                  <SelectPopup>{REGION_ITEMS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectPopup>
                </Select>
                <FieldDescription>Use the region where your SES identities already live, if you have any. Every region here can also receive mail.</FieldDescription>
              </Field>
              <Label className="flex items-start gap-2">
                <Checkbox checked={route53} onCheckedChange={(checked) => setRoute53(checked === true)} className="mt-0.5" />
                <span>
                  <span className="block font-medium text-foreground text-sm">Set up DNS in Route 53 for me</span>
                  <span className="block text-muted-foreground text-xs">If your domains are in Route 53, we add the DKIM and MX records ourselves. We never replace an MX record that points somewhere else.</span>
                </span>
              </Label>
              <ul className="space-y-1.5 rounded-xl bg-muted/60 p-3 text-muted-foreground text-xs">
                <li>• The stack creates one role that only HelloBox can use, locked to this connection.</li>
                <li>• Mail is sent from your account, under your reputation. We never see your AWS keys.</li>
                <li>• Delete the stack whenever you like and access ends straight away.</li>
              </ul>
            </DialogPanel>
            <DialogFooter>
              <Button type="submit" loading={starting}><ArrowSquareOut /> Open AWS</Button>
            </DialogFooter>
          </Form>
        ) : connection?.status === "active" ? (
          <>
            <DialogPanel>
              <div className="flex items-center gap-3 rounded-xl bg-brand-soft p-3 text-brand-foreground text-sm">
                <Check className="size-5 shrink-0" />
                Connected to AWS account {connection.accountId}. Add a domain or turn receiving on below.
              </div>
            </DialogPanel>
            <DialogFooter>
              <Button onClick={() => { setStarted(null); onOpenChange(false); }}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogPanel className="space-y-3">
              <div className="flex items-center gap-3 rounded-xl bg-brand-soft p-3 text-brand-foreground text-sm">
                <HourglassMedium className="size-5 shrink-0 animate-pulse" />
                {connection?.accountId
                  ? `Stack created in account ${connection.accountId}. Setting up sending and events…`
                  : "Waiting for the stack in AWS. This page updates by itself."}
              </div>
              <p className="text-muted-foreground text-xs">
                Didn&apos;t see the AWS tab? <a className="underline" href={started.url} target="_blank" rel="noreferrer">Open it again</a>. Sign in to the AWS account you want to use first.
              </p>
            </DialogPanel>
            <DialogFooter>
              <Button variant="ghost" onClick={() => { setStarted(null); onOpenChange(false); }}>Close</Button>
            </DialogFooter>
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
}

function SesConnection({ connection, data, refresh, admin, onReconnect }: {
  connection: Connection;
  data: Bootstrap;
  refresh: () => void;
  admin: boolean;
  onReconnect: () => void;
}) {
  const run = useRun();
  const detail = [regionName(connection.region), connection.accountId && `account ${connection.accountId}`].filter(Boolean).join(" · ");

  // SES receives for a list of domains, so the switch sends the whole list.
  async function setReceiving(domain: string, on: boolean) {
    const current = data.domains
      .filter((d) => d.connectionId === connection.id && !d.removedAt && d.receivingEnabled)
      .map((d) => d.name);
    const next = on ? [...new Set([...current, domain])] : current.filter((name) => name !== domain);
    const result = await call("/connections/ses/receiving", { connectionId: connection.id, domains: next });
    return result.mx.find((item) => item.records.some((record) => record.name === domain)) ?? null;
  }

  return (
    <div className="space-y-3 rounded-2xl border p-3">
      <ProviderRow icon={<AmazonSesIcon className="size-5 rounded-[5px]" />} name="Amazon SES" detail={detail} status={connection.status}>
        {admin && connection.status === "needs_reconnect" && <Button size="sm" onClick={onReconnect}>Connect again</Button>}
        {admin && (
          <DisconnectButton
            title="Disconnect Amazon SES?"
            description={
              <>
                New mail stops arriving and sending stops. Your existing mail stays here. To remove our access completely, delete the HelloBox stack in{" "}
                {connection.region ? (
                  <a className="underline" href={stackConsoleUrl(connection.region)} target="_blank" rel="noreferrer">CloudFormation</a>
                ) : "CloudFormation"}
                .
              </>
            }
            onConfirm={async () => {
              await run(() => call("/connections/disconnect", { id: connection.id }), "Disconnected");
              refresh();
            }}
          />
        )}
      </ProviderRow>

      {connection.status === "pending" && (
        <p className="text-muted-foreground text-xs">
          Waiting for the stack in your AWS account to finish. If you closed the AWS tab before creating it, disconnect this and connect again.
        </p>
      )}
      {connection.status === "needs_reconnect" && (
        <Alert variant="warning" className="rounded-xl">
          <Warning />
          <AlertDescription>HelloBox can&apos;t use the role in your AWS account any more. The stack may have been deleted. Connect again to pick up where you left off.</AlertDescription>
        </Alert>
      )}

      {connection.status === "active" && (
        <>
          <SandboxStatus connectionId={connection.id} admin={admin} defaultEmail={data.user.email} />
          <DomainList
            connection={connection}
            data={data}
            admin={admin}
            refresh={refresh}
            canAdd
            emptyText="No domains in this AWS account yet."
            receiving={(domain) => ({ on: domain.receivingEnabled })}
            setReceiving={setReceiving}
          />
        </>
      )}
    </div>
  );
}

function SandboxStatus({ connectionId, admin, defaultEmail }: { connectionId: string; admin: boolean; defaultEmail: string }) {
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [testing, setTesting] = useState(false);
  useEffect(() => {
    call("/connections/ses/status", { connectionId }).then(setStatus).catch(() => setStatus(null));
  }, [connectionId]);
  if (!status) return null;
  const quota = `${status.max24HourSend.toLocaleString()} a day, ${status.maxSendRate} a second.`;
  if (status.productionAccess) {
    return <p className="px-1 text-muted-foreground text-xs">Production access is on: {quota}</p>;
  }
  const reviewing = status.reviewStatus === "PENDING";
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl px-3 py-2 text-xs", reviewing ? "bg-info/8" : "bg-warning/10")}>
      <Warning className={cn("size-4 shrink-0", reviewing ? "text-info" : "text-warning")} />
      <span className="min-w-0 flex-1 text-foreground">
        {reviewing ? "AWS is reviewing your production access. Until then, SES only sends to verified addresses." : "Sandbox: SES only sends to addresses you've verified."}
        <span className="text-muted-foreground"> {quota}</span>
      </span>
      {admin && (
        <span className="ms-auto flex min-w-0 flex-wrap gap-1.5">
          <Button size="xs" variant="ghost" onClick={() => setTesting(true)}>Test recipients</Button>
          {!reviewing && <Button size="xs" onClick={() => setRequesting(true)}>Request production access</Button>}
        </span>
      )}
      <ProductionAccessDialog
        open={requesting}
        onOpenChange={setRequesting}
        connectionId={connectionId}
        defaultEmail={defaultEmail}
        onRequested={() => setStatus({ ...status, reviewStatus: "PENDING" })}
      />
      <Dialog open={testing} onOpenChange={setTesting}>
        <DialogPopup className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Test recipients</DialogTitle>
            <DialogDescription>
              Add an address and AWS emails it a confirmation link. Once it&apos;s confirmed, you can send to it from the sandbox. Addresses at your verified domains already work.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel><TestRecipients connectionId={connectionId} /></DialogPanel>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

// Sandbox accounts only deliver to verified addresses. Adding one here makes AWS email
// it a confirmation link, so people can test before production access comes through.
function TestRecipients({ connectionId }: { connectionId: string }) {
  const [adding, run] = useRunning();
  const [recipients, setRecipients] = useState<{ email: string; verified: boolean }[] | null>(null);
  const [email, setEmail] = useState("");
  const load = useCallback(() => {
    call("/connections/ses/test-recipients", { connectionId })
      .then((result) => setRecipients(result.recipients))
      .catch(() => setRecipients([]));
  }, [connectionId]);
  useEffect(load, [load]);

  return (
    <div className="space-y-2">
      {recipients && recipients.length > 0 && (
        <ul className="divide-y rounded-lg border">
          {recipients.map((recipient) => (
            <li key={recipient.email} className="flex items-center gap-2 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate text-foreground">{recipient.email}</span>
              {recipient.verified
                ? <Badge variant="success" size="sm">Confirmed</Badge>
                : <Badge variant="warning" size="sm">Waiting for the link</Badge>}
            </li>
          ))}
        </ul>
      )}
      <Form
        className="flex gap-2"
        onSubmit={async (event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const address = email.trim();
          const done = await run(
            () => call("/connections/ses/test-recipients/add", { connectionId, email: address }),
            `AWS sent a confirmation link to ${address}`,
          );
          if (done) { setEmail(""); load(); }
        }}
      >
        <Input type="email" required aria-label="Test recipient" placeholder="someone@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Button type="submit" variant="outline" loading={adding}>Add</Button>
        {recipients?.some((recipient) => !recipient.verified) && (
          <Button type="button" variant="ghost" onClick={load}>Refresh</Button>
        )}
      </Form>
    </div>
  );
}

const MAIL_TYPES = [
  { label: "Transactional and replies", value: "TRANSACTIONAL" },
  { label: "Marketing and campaigns", value: "MARKETING" },
];

function ProductionAccessDialog({ open, onOpenChange, connectionId, defaultEmail, onRequested }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: string;
  defaultEmail: string;
  onRequested: () => void;
}) {
  const [sending, run] = useRunning();
  const [mailType, setMailType] = useState("TRANSACTIONAL");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [email, setEmail] = useState(defaultEmail);
  // Prefilled from what HelloBox set up for this connection. Once edited, it's theirs, and
  // changing the mail type no longer rewrites it.
  const [useCase, setUseCase] = useState("");
  const [edited, setEdited] = useState(false);
  useEffect(() => {
    if (!open || edited) return;
    let current = true;
    call("/connections/ses/use-case", { connectionId, mailType: mailType as "TRANSACTIONAL" | "MARKETING" })
      .then((result) => { if (current) setUseCase(result.text); })
      .catch(() => undefined);
    return () => { current = false; };
  }, [open, edited, connectionId, mailType]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Request production access</DialogTitle>
          <DialogDescription>AWS reviews every request and says it responds within 96 hours. They may email you with questions, and approval is up to them.</DialogDescription>
        </DialogHeader>
        <Form
          className="contents"
          onSubmit={async (event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            const done = await run(
              () =>
                call("/connections/ses/production-access", {
                  connectionId,
                  mailType: mailType as "TRANSACTIONAL" | "MARKETING",
                  websiteUrl,
                  contactEmails: [email],
                  useCaseDescription: useCase.trim() || undefined,
                }),
              "Request sent to AWS",
            );
            if (done) { onRequested(); onOpenChange(false); }
          }}
        >
          <DialogPanel className="space-y-4">
            <Field>
              <FieldLabel>What you&apos;ll mostly send</FieldLabel>
              <Select value={mailType} items={MAIL_TYPES} onValueChange={(value) => { if (value) setMailType(value); }}>
                <SelectTrigger aria-label="Mail type"><SelectValue /></SelectTrigger>
                <SelectPopup>{MAIL_TYPES.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectPopup>
              </Select>
            </Field>
            <Field>
              <FieldLabel>Your website</FieldLabel>
              <Input type="url" required placeholder="https://yourdomain.com" value={websiteUrl} onChange={(e) => setWebsiteUrl(e.target.value)} />
            </Field>
            <Field>
              <FieldLabel>Where AWS can reach you</FieldLabel>
              <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field>
              <span className="flex w-full items-center justify-between gap-2">
                <FieldLabel>How you&apos;ll use SES</FieldLabel>
                {useCase && <CopyValue value={useCase} />}
              </span>
              <Textarea
                rows={8}
                maxLength={5000}
                placeholder="Loading a draft…"
                value={useCase}
                onChange={(e) => { setUseCase(e.target.value); setEdited(true); }}
              />
              <FieldDescription>
                Written from what HelloBox set up for this account. Edit it so it matches how you send. Keep a copy: AWS reviewers often ask for this by email.
              </FieldDescription>
            </Field>
          </DialogPanel>
          <DialogFooter>
            <Button type="submit" loading={sending}>Send request</Button>
          </DialogFooter>
        </Form>
      </DialogPopup>
    </Dialog>
  );
}

type PostmarkServerChoice = { id: number; name: string; inboundDomain: string | null; hasOtherHook: boolean };

// Paste the account token, then pick a server: ours by default, or one that exists.
function PostmarkConnectDialog({ open, onOpenChange, reconnectId, refresh }: {
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

function ServerChoice({ selected, onSelect, title, detail }: { selected: boolean; onSelect: () => void; title: string; detail: string }) {
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
      <span className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border", selected && "border-brand bg-brand text-white")}>
        {selected && <Check className="size-2.5" weight="bold" />}
      </span>
      <span className="min-w-0">
        <span className="block font-medium text-foreground text-sm">{title}</span>
        <span className="block text-muted-foreground text-xs">{detail}</span>
      </span>
    </button>
  );
}

function PostmarkConnection({ connection, data, refresh, admin, onReconnect }: {
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

type MailgunRegion = "us" | "eu";
const MAILGUN_REGIONS: Record<MailgunRegion, string> = { us: "US", eu: "EU" };

// Paste the API key and the signing key. The region is found from where the domains
// are; only when that's unclear does a second step ask for it.
function MailgunConnectDialog({ open, onOpenChange, reconnectId, refresh }: {
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

function MailgunConnection({ connection, data, refresh, admin, onReconnect }: {
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
