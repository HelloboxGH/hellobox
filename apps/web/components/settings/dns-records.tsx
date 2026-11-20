"use client";

import { Check, Copy, Warning } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { PROVIDER_INFO, type DnsRecord } from "@hellobox/providers/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { type Bootstrap, call } from "@/core/client/api";
import { useSearchParam } from "@/core/client/use-search-param";
import { CloudflareIcon } from "@/components/brand-icons";
import { useRun } from "./shared";

type Connection = Bootstrap["connections"][number];
export type DnsHost = "route53" | "cloudflare";
// autoApply writes the records as soon as they load, when Route 53 or Cloudflare can take them.
export type DnsTarget = { domain: string; setup: DnsSetup | null; autoApply?: boolean };
export type DnsSetup = {
  records: DnsRecord[];
  applied: DnsRecord[];
  skipped: DnsRecord[];
  appliedTo: DnsHost | null;
  zoneFound: boolean | null;
  cloudflare: { onCloudflare: boolean; connected: boolean };
};
export const HOST_NAMES: Record<DnsHost, string> = { route53: "Route 53", cloudflare: "Cloudflare" };

// Whether some records still have to be added by hand.
export const needsHandAdding = (setup: DnsSetup) => setup.applied.length < setup.records.length;

// The DNS dialog's domain. Back from connecting Cloudflare, it reopens the domain it was
// connected for, and adds its records.
export function useDnsTarget(connectionId: string) {
  const returnedConnection = useSearchParam("ses");
  const returnedDomain = useSearchParam("dns");
  const returnedFor = returnedConnection === connectionId ? returnedDomain : null;
  const [dns, setDns] = useState<DnsTarget | null>(null);
  const [handledReturn, setHandledReturn] = useState(false);
  if (returnedFor && !handledReturn) {
    setHandledReturn(true);
    setDns({ domain: returnedFor, setup: null, autoApply: true });
  }
  // So a reload doesn't add the records again.
  useEffect(() => {
    if (returnedFor) window.history.replaceState(null, "", "/settings?tab=connection");
  }, [returnedFor]);
  return [dns, setDns] as const;
}

export function CopyValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      aria-label="Copy"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}

export function DnsDialog({ connection, workspaceId, target, admin, onClose, onChanged }: {
  connection: Connection;
  workspaceId: string;
  target: DnsTarget | null;
  admin: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogPopup className="sm:max-w-2xl">
        {target && (
          <DnsRecords
            key={target.domain}
            connection={connection}
            workspaceId={workspaceId}
            domain={target.domain}
            initial={target.setup}
            autoApply={admin && target.autoApply}
            admin={admin}
            onClose={onClose}
            onChanged={onChanged}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}

function DnsRecords({ connection, workspaceId, domain, initial, autoApply, admin, onClose, onChanged }: {
  connection: Connection;
  workspaceId: string;
  domain: string;
  initial: DnsSetup | null;
  autoApply?: boolean;
  admin: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const run = useRun();
  const [records, setRecords] = useState<DnsRecord[] | null>(initial?.records ?? null);
  const [setup, setSetup] = useState<DnsSetup | null>(initial);
  // Where records are being written right now, so its button shows it and can't run twice.
  const [applying, setApplying] = useState<DnsHost | null>(null);
  const changed = useRef(onChanged);
  useEffect(() => {
    changed.current = onChanged;
  }, [onChanged]);

  useEffect(() => {
    if (initial) return;
    call("/connections/domains/records", { connectionId: connection.id, domain })
      .then(async (result) => {
        setRecords(result.records);
        setSetup({ records: result.records, applied: [], skipped: [], appliedTo: null, zoneFound: result.zoneFound, cloudflare: result.cloudflare });
        const host: DnsHost | null =
          connection.route53 && result.zoneFound ? "route53"
          : result.cloudflare.onCloudflare && result.cloudflare.connected ? "cloudflare"
          : null;
        if (!autoApply || !host) return;
        setApplying(host);
        const written = await call("/connections/domains/apply-dns", { connectionId: connection.id, domain, host }).catch(() => null);
        setApplying(null);
        if (written) {
          setSetup(written);
          setRecords(written.records);
          changed.current();
        }
      })
      .catch(() => setRecords([]));
  }, [initial, autoApply, connection.id, connection.route53, domain]);

  const applied = new Set(setup?.applied.map((record) => `${record.type}:${record.name}`));
  const skippedMx = setup?.skipped.some((record) => record.type === "MX");
  const skippedDmarc = setup?.skipped.some((record) => record.name.startsWith("_dmarc."));
  const onCloudflare = setup?.cloudflare.onCloudflare ?? false;

  async function apply(host: DnsHost) {
    if (applying) return;
    setApplying(host);
    await run(async () => {
      const result = await call("/connections/domains/apply-dns", { connectionId: connection.id, domain, host });
      setSetup(result);
      setRecords(result.records);
      if (!result.appliedTo) throw new Error(`We couldn't find this domain in ${HOST_NAMES[host]}`);
    }, `DNS updated in ${HOST_NAMES[host]}`);
    setApplying(null);
    onChanged();
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>DNS records for {domain}</DialogTitle>
        <DialogDescription>
          Add these at your DNS provider. {PROVIDER_INFO[connection.provider].name} checks them by itself, and the domain shows as verified once they&apos;re live, usually within an hour.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="space-y-3">
        {setup?.zoneFound === false && !onCloudflare && (
          <Alert variant="info" className="rounded-xl"><Warning /><AlertDescription>We couldn&apos;t find this domain in Route 53, so add the records wherever your DNS is hosted.</AlertDescription></Alert>
        )}
        {skippedMx && (
          <Alert variant="warning" className="rounded-xl"><Warning /><AlertDescription>This domain already has an MX record that points somewhere else, so we left it alone. Replacing it moves all of the domain&apos;s incoming mail to HelloBox.</AlertDescription></Alert>
        )}
        {skippedDmarc && (
          <Alert variant="info" className="rounded-xl"><Warning /><AlertDescription>This domain already has a DMARC policy, so we kept it.</AlertDescription></Alert>
        )}
        {setup?.appliedTo && setup.applied.length > 0 && (
          <Alert variant="success" className="rounded-xl"><Check /><AlertDescription>Added to {HOST_NAMES[setup.appliedTo]}. The domain verifies by itself once the records are live, usually within minutes.</AlertDescription></Alert>
        )}
        {applying && <p className="text-muted-foreground text-sm">Adding the records to {HOST_NAMES[applying]}…</p>}
        {!records ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : (
          <ul className="space-y-2">
            {records.map((record) => (
              <li key={`${record.type}:${record.name}:${record.value}`} className="rounded-xl border p-3 text-sm">
                <div className="mb-1.5 flex items-center gap-2">
                  <Badge variant="outline" size="sm">{record.type}</Badge>
                  <span className="text-muted-foreground text-xs">{record.purpose}</span>
                  {setup?.appliedTo && applied.has(`${record.type}:${record.name}`) && <Badge variant="success" size="sm" className="ms-auto">Added to {HOST_NAMES[setup.appliedTo]}</Badge>}
                </div>
                <div className="grid gap-1 font-mono text-xs">
                  <span className="flex items-center gap-1"><span className="w-12 shrink-0 text-muted-foreground">Name</span><span className="min-w-0 flex-1 break-all">{record.name}</span><CopyValue value={record.name} /></span>
                  <span className="flex items-center gap-1">
                    <span className="w-12 shrink-0 text-muted-foreground">Value</span>
                    <span className="min-w-0 flex-1 break-all">{record.priority !== undefined ? `${record.priority} ` : ""}{record.value}</span>
                    <CopyValue value={record.value} />
                  </span>
                </div>
              </li>
            ))}
            {records.length === 0 && <li className="text-muted-foreground text-sm">No records to add.</li>}
          </ul>
        )}
      </DialogPanel>
      <DialogFooter>
        {admin && connection.route53 && (
          <Button
            variant="outline"
            loading={applying === "route53"}
            disabled={setup?.zoneFound === false || applying !== null}
            title={setup?.zoneFound === false ? "This domain's DNS isn't in Route 53" : undefined}
            onClick={() => apply("route53")}
          >
            Add to Route 53
          </Button>
        )}
        {admin && onCloudflare && (setup?.cloudflare.connected ? (
          <Button variant="outline" loading={applying === "cloudflare"} disabled={applying !== null} onClick={() => apply("cloudflare")}>
            <CloudflareIcon className="text-[#F38020]" /> Add to Cloudflare
          </Button>
        ) : (
          // Cloudflare's own orange, so it reads as their sign-in.
          <Button
            className="border-[#F38020] bg-[#F38020] text-white shadow-[0_1px_2px_rgb(0_0_0/0.15)] hover:bg-[#E06D10] focus-visible:ring-[#F38020]/40 [&_svg]:text-white"
            render={<a href={`/api/cloudflare/oauth/start?${new URLSearchParams({ workspace: workspaceId, connection: connection.id, domain })}`} />}
          >
            <CloudflareIcon /> Connect Cloudflare
          </Button>
        ))}
        <Button onClick={onClose}>Done</Button>
      </DialogFooter>
    </>
  );
}
