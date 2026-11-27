"use client";

import { Check, Warning } from "@phosphor-icons/react";
import { type ReactNode, useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { type Bootstrap, call } from "@/core/client/api";
import { notify, notifyInfo } from "@/core/client/notify";
import { CloudflareIcon } from "@/components/brand-icons";
import { CopyValue } from "./dns-records";
import { useRunning } from "./shared";

type Domain = Bootstrap["domains"][number];
type Setup = {
  record: { name: string; value: string };
  mx: { name: string; value: string; priority: number };
  cloudflare: { onCloudflare: boolean; connected: boolean };
  replacedMx: OtherMx[];
};
type OtherMx = { value: string; priority: number };

const CHECK_TRIES = 6;
const CHECK_EVERY_MS = 5000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Receiving a domain's mail with HelloBox's own mail server instead of the provider. The
// order matters: the domain is turned on here first (proven with a TXT record), and only
// then does its MX record move. The other way round, the mail server refuses the domain's
// mail for good while it waits.
export function HelloboxReceivingDialog({ domain, onClose, refresh }: {
  domain: Domain | null;
  onClose: () => void;
  refresh: () => void;
}) {
  return (
    <Dialog open={domain !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogPopup className="sm:max-w-xl">
        {domain && <Steps key={domain.id} domain={domain} onClose={onClose} refresh={refresh} />}
      </DialogPopup>
    </Dialog>
  );
}

function Steps({ domain, onClose, refresh }: { domain: Domain; onClose: () => void; refresh: () => void }) {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [on, setOn] = useState(domain.receiveWithHellobox);
  const [loading, runLoad] = useRunning();
  const [checking, runCheck] = useRunning();
  const [stopping, runStop] = useRunning();
  const [confirmStop, setConfirmStop] = useState(false);
  const [writingTxt, runTxt] = useRunning();
  const [writingMx, runMx] = useRunning();
  const [removingMx, runRemoveMx] = useRunning();
  const [restoring, runRestore] = useRunning();
  const [restored, setRestored] = useState(false);
  // MX records already on the domain, waiting for the user to agree they get replaced.
  const [replacing, setReplacing] = useState<OtherMx[] | null>(null);
  const [mxDone, setMxDone] = useState(false);
  const withCloudflare = Boolean(setup?.cloudflare.connected && setup.cloudflare.onCloudflare);

  // DNS takes a moment to show a new record, so the check is tried a few times.
  async function confirmWithRetries() {
    for (let attempt = 0; attempt < CHECK_TRIES; attempt++) {
      if (attempt) await sleep(CHECK_EVERY_MS);
      const result = await call("/domains/receiving/confirm", { domainId: domain.id });
      if (result.on) return true;
    }
    return false;
  }

  function turnedOn() {
    setOn(true);
    notify(`HelloBox now receives ${domain.name}. Point its MX record here next.`);
    refresh();
  }

  async function mx(replace: boolean) {
    await runMx(async () => {
      const result = await call("/domains/receiving/cloudflare-mx", { domainId: domain.id, replace });
      if (result.status === "needs-confirmation") {
        setReplacing(result.existing);
        return;
      }
      setReplacing(null);
      setMxDone(true);
      notify(result.status === "already" ? "The MX record already points at HelloBox" : "The MX record now points at HelloBox");
    });
  }

  // The records come from the server, which makes the TXT token on first use.
  useEffect(() => {
    void runLoad(async () => setSetup(await call("/domains/receiving/start", { domainId: domain.id })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domain.id]);

  if (confirmStop) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Stop receiving {domain.name} with HelloBox?</DialogTitle>
          <DialogDescription>
            Point the MX record back at your provider first. Until it changes, senders still reach the HelloBox mail server, and it refuses
            their mail once receiving is off here.
          </DialogDescription>
        </DialogHeader>
        {withCloudflare && (
          <DialogPanel>
            <p className="text-muted-foreground text-xs">
              {setup?.replacedMx.length && !restored
                ? "HelloBox replaced these MX records. Put them back, and HelloBox's record comes off."
                : "Restore your provider's MX record in Cloudflare first. Then take HelloBox's record off."}
            </p>
            {setup?.replacedMx.length && !restored ? (
              <>
                <span className="mt-2 block font-mono text-xs">
                  {setup.replacedMx.map((item) => (
                    <span key={`${item.priority}:${item.value}`} className="block break-all">{item.priority} {item.value}</span>
                  ))}
                </span>
                <Button
                  variant="outline"
                  className="mt-2"
                  loading={restoring}
                  onClick={async () => {
                    if (await runRestore(() => call("/domains/receiving/cloudflare-restore-mx", { domainId: domain.id }), "Your MX records are back")) setRestored(true);
                  }}
                >
                  <CloudflareIcon className="text-[#F38020]" /> Put them back
                </Button>
              </>
            ) : null}
            <Button
              variant="outline"
              className="mt-2"
              loading={removingMx}
              onClick={() =>
                runRemoveMx(async () => {
                  const result = await call("/domains/receiving/cloudflare-remove-mx", { domainId: domain.id });
                  notify(result.removed ? "HelloBox's MX record was removed" : "HelloBox's MX record wasn't there");
                })
              }
            >
              <CloudflareIcon className="text-[#F38020]" /> Just remove HelloBox&apos;s MX record
            </Button>
          </DialogPanel>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => setConfirmStop(false)}>Back</Button>
          <Button
            variant="destructive"
            loading={stopping}
            onClick={async () => {
              const done = await runStop(() => call("/domains/receiving/stop", { domainId: domain.id }), `HelloBox no longer receives ${domain.name}`);
              if (done) {
                refresh();
                onClose();
              }
            }}
          >
            Stop receiving
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Receive {domain.name} with HelloBox</DialogTitle>
        <DialogDescription>
          Mail for this domain comes straight to HelloBox&apos;s mail server instead of through your provider. You keep sending with your provider.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="space-y-4">
        {loading && !setup && <p className="text-muted-foreground text-sm">Loading the records…</p>}
        {setup && (
          <>
            <Step number={1} title="Prove you control the domain" done={on}>
              <p className="text-muted-foreground text-xs">Add this TXT record where the domain&apos;s DNS is managed. It can stay there afterwards.</p>
              <Record type="TXT" rows={[["Name", setup.record.name], ["Value", setup.record.value]]} />
              {withCloudflare && !on && (
                <Button
                  variant="outline"
                  size="sm"
                  loading={writingTxt || checking}
                  onClick={() =>
                    runTxt(async () => {
                      await call("/domains/receiving/cloudflare-txt", { domainId: domain.id });
                      notifyInfo("Added to Cloudflare. Checking it now…");
                      if (await confirmWithRetries()) await turnedOn();
                      else notifyInfo("The record is in Cloudflare but isn't visible yet. Try \"Check and turn on\" in a minute.");
                    })
                  }
                >
                  <CloudflareIcon className="text-[#F38020]" /> Add it to Cloudflare
                </Button>
              )}
            </Step>
            <Step number={2} title="Turn it on" done={on}>
              <p className="text-muted-foreground text-xs">
                {on
                  ? "HelloBox's mail server now takes mail for this domain."
                  : "Once the TXT record is live, check it. The mail server then takes this domain's mail as soon as the MX record points at it."}
              </p>
            </Step>
            <Step number={3} title="Point the MX record at HelloBox" done={false} disabled={!on}>
              <p className="text-muted-foreground text-xs">
                Replace the domain&apos;s MX records with this one. Any other MX record left in place gets part of the mail.
              </p>
              <Record type="MX" rows={[["Name", setup.mx.name], ["Value", setup.mx.value], ["Priority", String(setup.mx.priority)]]} />
              {withCloudflare && (
                <>
                  <Button variant="outline" size="sm" disabled={!on || mxDone || replacing !== null} loading={writingMx && replacing === null} onClick={() => mx(false)}>
                    <CloudflareIcon className="text-[#F38020]" /> Point MX to HelloBox on Cloudflare
                  </Button>
                  {replacing && (
                    <Alert variant="warning" className="rounded-xl">
                      <Warning />
                      <AlertDescription className="space-y-2">
                        <span className="block">
                          {domain.name} already has MX records. Replacing them means mail stops going there (for example Google Workspace or your provider&apos;s inbound):
                        </span>
                        <span className="block font-mono text-xs">
                          {replacing.map((item) => (
                            <span key={`${item.priority}:${item.value}`} className="block break-all">{item.priority} {item.value}</span>
                          ))}
                        </span>
                        <span className="flex gap-2">
                          <Button size="sm" variant="destructive" loading={writingMx} onClick={() => mx(true)}>Replace them</Button>
                          <Button size="sm" variant="ghost" onClick={() => setReplacing(null)}>Keep them</Button>
                        </span>
                      </AlertDescription>
                    </Alert>
                  )}
                </>
              )}
              {!on && (
                <Alert variant="warning" className="rounded-xl">
                  <Warning />
                  <AlertDescription>Only after step 2. Before that, the mail server refuses this domain&apos;s mail and senders get a bounce.</AlertDescription>
                </Alert>
              )}
              {on && (
                <Alert variant="success" className="rounded-xl">
                  <Check />
                  <AlertDescription>Safe to change now. Mail already on its way to your provider still arrives there while DNS updates.</AlertDescription>
                </Alert>
              )}
            </Step>
          </>
        )}
      </DialogPanel>
      <DialogFooter>
        {on ? (
          <>
            <Button variant="ghost" onClick={() => setConfirmStop(true)}>Stop receiving</Button>
            <Button onClick={onClose}>Done</Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>Close</Button>
            <Button
              loading={checking}
              disabled={!setup}
              onClick={() =>
                runCheck(async () => {
                  const result = await call("/domains/receiving/confirm", { domainId: domain.id });
                  if (!result.on) {
                    notifyInfo("We can't see the TXT record yet. DNS changes can take a few minutes, so try again shortly.");
                    return;
                  }
                  await turnedOn();
                })
              }
            >
              Check and turn on
            </Button>
          </>
        )}
      </DialogFooter>
    </>
  );
}

function Step({ number, title, done, disabled, children }: {
  number: number;
  title: string;
  done: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={`space-y-2 ${disabled ? "opacity-64" : ""}`}>
      <p className="flex items-center gap-2 font-medium text-foreground text-sm">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full border text-xs tabular-nums">
          {done ? <Check className="size-3" /> : number}
        </span>
        {title}
      </p>
      <div className="space-y-2 ps-7">{children}</div>
    </section>
  );
}

function Record({ type, rows }: { type: string; rows: [string, string][] }) {
  return (
    <div className="rounded-xl border p-3 text-sm">
      <Badge variant="outline" size="sm" className="mb-1.5">{type}</Badge>
      <div className="grid gap-1 font-mono text-xs">
        {rows.map(([label, value]) => (
          <span key={label} className="flex items-center gap-1">
            <span className="w-16 shrink-0 text-muted-foreground">{label}</span>
            <span className="min-w-0 flex-1 break-all">{value}</span>
            <CopyValue value={value} />
          </span>
        ))}
      </div>
    </div>
  );
}
