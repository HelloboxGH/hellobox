"use client";

import { ArrowSquareOut, Check, HourglassMedium, Warning } from "@phosphor-icons/react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { SES_REGIONS, stackConsoleUrl, type SesRegion } from "@hellobox/providers/connect";
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
import { AmazonSesIcon } from "@/components/brand-icons";
import { cn } from "@/lib/utils";
import { CopyValue } from "../dns-records";
import { DomainList } from "../provider-domains";
import { useRun, useRunning } from "../shared";
import { type Connection, DisconnectButton, ProviderRow } from "./shared";

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

export function SesConnectDialog({ open, onOpenChange, data, refresh }: {
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

export function SesConnection({ connection, data, refresh, admin, onReconnect }: {
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
