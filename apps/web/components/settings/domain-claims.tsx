"use client";

import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { type Bootstrap, call } from "@/core/client/api";
import { notifyInfo } from "@/core/client/notify";
import { Warning } from "@phosphor-icons/react";
import { useState } from "react";
import { CopyValue } from "./dns-records";
import { useRunning } from "./shared";

type Domain = Bootstrap["domains"][number];
type OutgoingClaim = Bootstrap["domainClaims"]["outgoing"][number];

const formatDay = (value: Date | string | null) =>
  value ? new Date(value).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) : "";

const key = (name: string) => name.trim().toLowerCase().replace(/\.$/, "");

// Who has this domain on instead: another provider in this workspace, or another
// workspace. Nothing is said about another workspace until the domain is verified here
// (see claimConflictMessage on the server).
export function claimedState(domain: Domain, data: Bootstrap) {
  if (!domain.claimedElsewhere || domain.enabled) return null;
  const here = data.domains.find(
    (other) => other.id !== domain.id && key(other.name) === key(domain.name) && other.enabled && !other.removedAt && other.status === "verified",
  );
  if (here) return { kind: "this-workspace" as const, note: "On through another provider here. Remove it there to use this one." };
  if (domain.status !== "verified") return { kind: "unverified" as const, note: "Verify it with your provider to use it." };
  return { kind: "other-workspace" as const, note: "In use in another HelloBox workspace." };
}

// On the holder's side: claims on its domains in their notice period.
export function IncomingClaims({ data, refresh }: { data: Bootstrap; refresh: () => void }) {
  const [keeping, runKeep] = useRunning();
  if (!data.domainClaims.incoming.length) return null;
  return (
    <div className="space-y-2">
      {data.domainClaims.incoming.map((claim) => (
        <Alert key={claim.id} variant="warning" className="rounded-xl">
          <Warning />
          <AlertDescription className="space-y-2">
            <p>
              Someone who controls the DNS for <strong>{claim.domain}</strong> is claiming it. It moves to their workspace on{" "}
              {formatDay(claim.noticeEndsAt)} unless you keep it.
            </p>
            <Button
              size="sm"
              variant="outline"
              className="w-fit"
              loading={keeping}
              onClick={async () => {
                if (await runKeep(() => call("/domains/claim/keep", { id: claim.id }), `${claim.domain} stays here`)) refresh();
              }}
            >
              Keep domain
            </Button>
          </AlertDescription>
        </Alert>
      ))}
    </div>
  );
}

// On the claimer's side: what to do about a domain another workspace has on.
export function ClaimDomainButton({ domain, data, refresh }: { domain: Domain; data: Bootstrap; refresh: () => void }) {
  const [open, setOpen] = useState(false);
  const claim = data.domainClaims.outgoing.find((item) => item.domainId === domain.id);
  return (
    <>
      <Button size="xs" variant="outline" onClick={() => setOpen(true)}>
        {claim ? (claim.status === "notice" ? "Claim pending" : "Finish claim") : "Get access"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="sm:max-w-lg">
          <ClaimDialog domain={domain} claim={claim} refresh={refresh} onClose={() => setOpen(false)} />
        </DialogPopup>
      </Dialog>
    </>
  );
}

type Outcome = "holder-active" | "holder-sso" | "free" | null;

const OUTCOMES: Record<Exclude<Outcome, null>, string> = {
  "holder-active": "The workspace that has it is still in use, so it can't be claimed. Ask its admins for access instead.",
  "holder-sso": "The workspace that has it uses this domain for single sign-on, so it can't be claimed. Ask its admins for access instead.",
  free: "Nobody else has it on any more. You can turn it on now.",
};

function ClaimDialog({ domain, claim, refresh, onClose }: { domain: Domain; claim: OutgoingClaim | undefined; refresh: () => void; onClose: () => void }) {
  const [asking, runAsk] = useRunning();
  const [starting, runStart] = useRunning();
  const [checking, runCheck] = useRunning();
  const [withdrawing, runWithdraw] = useRunning();
  const [outcome, setOutcome] = useState<Outcome>(null);

  const askForAccess = (
    <Button
      variant="outline"
      loading={asking}
      onClick={async () => {
        if (await runAsk(() => call("/domains/request-access", { domainId: domain.id }), "Request sent to its admins")) onClose();
      }}
    >
      Ask for access
    </Button>
  );

  if (outcome) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>{domain.name}</DialogTitle>
          <DialogDescription>{OUTCOMES[outcome]}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          {outcome !== "free" && askForAccess}
        </DialogFooter>
      </>
    );
  }

  if (claim?.status === "notice") {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Claiming {domain.name}</DialogTitle>
          <DialogDescription>
            Its current workspace&apos;s admins have been told. It moves to you on {formatDay(claim.noticeEndsAt)} unless one of them keeps
            it or uses that workspace before then. Keep the TXT record in place until it does.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <TxtRecord claim={claim} />
        </DialogPanel>
        <DialogFooter>
          <WithdrawButton claim={claim} running={withdrawing} run={runWithdraw} refresh={refresh} onClose={onClose} />
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </>
    );
  }

  if (claim) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Prove you control {domain.name}</DialogTitle>
          <DialogDescription>Add this TXT record where the domain&apos;s DNS is managed, then check it. It can take a few minutes to show up.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <TxtRecord claim={claim} />
        </DialogPanel>
        <DialogFooter>
          <WithdrawButton claim={claim} running={withdrawing} run={runWithdraw} refresh={refresh} onClose={onClose} />
          <Button
            loading={checking}
            onClick={() =>
              runCheck(async () => {
                const result = await call("/domains/claim/check", { id: claim.id });
                if (result.state === "dns") {
                  notifyInfo("We can't see the TXT record yet. DNS changes can take a few minutes, so try again shortly.");
                  return;
                }
                refresh();
                if (result.state !== "notice") setOutcome(result.state);
              })
            }
          >
            Check DNS
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{domain.name} is in use elsewhere</DialogTitle>
        <DialogDescription>Another HelloBox workspace has it on. A domain can only be on in one place.</DialogDescription>
      </DialogHeader>
      <DialogPanel className="space-y-3 text-sm">
        <div className="rounded-xl border p-3">
          <p className="font-medium text-foreground">Ask for access</p>
          <p className="text-muted-foreground">We email that workspace&apos;s admins your name and email so they can invite you. We don&apos;t tell you who they are.</p>
        </div>
        <div className="rounded-xl border p-3">
          <p className="font-medium text-foreground">Claim it</p>
          <p className="text-muted-foreground">
            If nobody has used that workspace for 90 days, you can claim the domain by proving you control its DNS. Its admins get 7
            days&apos; notice, and using the workspace or keeping the domain stops the claim.
          </p>
        </div>
      </DialogPanel>
      <DialogFooter>
        {askForAccess}
        <Button
          loading={starting}
          onClick={async () => {
            if (await runStart(() => call("/domains/claim/start", { domainId: domain.id }))) refresh();
          }}
        >
          Claim it
        </Button>
      </DialogFooter>
    </>
  );
}

function TxtRecord({ claim }: { claim: OutgoingClaim }) {
  return (
    <div className="rounded-xl border p-3 text-sm">
      <div className="mb-1.5 flex items-center gap-2">
        <Badge variant="outline" size="sm">TXT</Badge>
        <span className="text-muted-foreground text-xs">Proves you control the domain</span>
      </div>
      <div className="grid gap-1 font-mono text-xs">
        <span className="flex items-center gap-1">
          <span className="w-12 shrink-0 text-muted-foreground">Name</span>
          <span className="min-w-0 flex-1 break-all">{claim.record.name}</span>
          <CopyValue value={claim.record.name} />
        </span>
        <span className="flex items-center gap-1">
          <span className="w-12 shrink-0 text-muted-foreground">Value</span>
          <span className="min-w-0 flex-1 break-all">{claim.record.value}</span>
          <CopyValue value={claim.record.value} />
        </span>
      </div>
    </div>
  );
}

function WithdrawButton({ claim, running, run, refresh, onClose }: {
  claim: OutgoingClaim;
  running: boolean;
  run: ReturnType<typeof useRunning>[1];
  refresh: () => void;
  onClose: () => void;
}) {
  return (
    <Button
      variant="ghost"
      loading={running}
      onClick={async () => {
        if (await run(() => call("/domains/claim/withdraw", { id: claim.id }), "Claim cancelled")) {
          refresh();
          onClose();
        }
      }}
    >
      Cancel claim
    </Button>
  );
}
