"use client";

import { ArrowElbowDownRight, Globe, Trash } from "@phosphor-icons/react";
import { useState } from "react";
import { groupDomains, planDomainCount } from "@hellobox/mail/domain-names";
import { PROVIDER_INFO } from "@hellobox/providers/types";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { type Bootstrap, call } from "@/core/client/api";
import { clientExtensions } from "@/core/client/extensions";
import { notifyInfo } from "@/core/client/notify";
import { cn } from "@/lib/utils";
import { ClaimDomainButton, claimedState, IncomingClaims } from "../domain-claims";
import { ProvidersSection } from "../providers-section";
import { connectionLabel } from "../providers/shared";
import { Section, useRun, useRunning } from "../shared";

const { UpgradeHint } = clientExtensions;

type Domain = Bootstrap["domains"][number];

export function ConnectionTab({ data, refresh }: { data: Bootstrap; refresh: () => void }) {
  const domainLimit = data.entitlements.limits.domains;
  const run = useRun();
  const admin = data.role !== "member";
  const active = data.connections.filter((c) => c.status !== "disconnected");
  const connectionOf = (connectionId: string) => data.connections.find((c) => c.id === connectionId);
  const disconnected = (domain: Domain) => connectionOf(domain.connectionId)?.status === "disconnected";
  const live = data.domains.filter((d) => !d.removedAt);
  const removed = data.domains.filter((d) => d.removedAt);
  // The same rule the server counts by: on, and not on a disconnected connection, with
  // subdomains counted under their parent.
  const counted = live.filter((d) => d.enabled && !disconnected(d)).map((d) => d.name);
  const enabled = planDomainCount(counted);
  const [toggling, setToggling] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [syncing, runSync] = useRunning();
  return (
    <div className="space-y-4">
      <Section title="Email providers" description="Where your mail is sent from and received. Your provider bills for sending, not us.">
        <ProvidersSection data={data} refresh={refresh} admin={admin} />
      </Section>

      <Section
        title="Domains"
        description={`${enabled} active${domainLimit === null ? "" : ` of ${domainLimit} on your plan`}. Inactive domains keep their mail until you make room.`}
      >
        {admin && <IncomingClaims data={data} refresh={refresh} />}
        <ul className="divide-y">
          {groupDomains(live).map(({ domain, parent }) => {
            const connection = connectionOf(domain.connectionId);
            const claimed = claimedState(domain, data);
            return (
              <li key={domain.id} className={cn("flex items-center gap-3 py-2.5", parent && "ps-7")}>
                {parent
                  ? <ArrowElbowDownRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  : <Globe className="size-4 shrink-0 text-muted-foreground" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-foreground text-sm">{domain.name}</span>
                  <span className="block text-muted-foreground text-xs">
                    {connectionLabel(connection)}
                    {" · "}
                    {claimed
                      ? claimed.note
                      : disconnected(domain)
                      ? "Disconnected. Its mail stays here."
                      : domain.receiveWithHellobox
                        ? "Receiving with HelloBox"
                        : domain.receivingEnabled
                        ? "Receiving on"
                        : "Receiving off"}
                  </span>
                </span>
                {admin && claimed?.kind === "other-workspace" && <ClaimDomainButton domain={domain} data={data} refresh={refresh} />}
                <Switch
                  aria-label={`Use ${domain.name}`}
                  checked={domain.enabled}
                  disabled={!admin || toggling !== null || claimed !== null}
                  onCheckedChange={async (checked) => {
                    setToggling(domain.id);
                    await run(() => call("/domains/set-enabled", { id: domain.id, enabled: checked }));
                    setToggling(null);
                    refresh();
                  }}
                />
                {admin && <RemoveDomainButton domain={domain} data={data} refresh={refresh} />}
              </li>
            );
          })}
          {live.length === 0 && <li className="py-2 text-muted-foreground text-sm">No domains yet.</li>}
        </ul>
        {removed.length > 0 && (
          <div className="space-y-1">
            <p className="font-medium text-foreground text-sm">Removed from HelloBox</p>
            <p className="text-muted-foreground text-xs">Their mail stays here to read. Restore one, or add it again, to send and receive with it.</p>
            <ul className="divide-y">
              {removed.map((domain) => (
                <li key={domain.id} className="flex items-center gap-3 py-2.5">
                  <Globe className="size-4 shrink-0 text-muted-foreground opacity-64" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-muted-foreground text-sm">{domain.name}</span>
                    <span className="block truncate text-muted-foreground text-xs">{connectionLabel(connectionOf(domain.connectionId))}</span>
                  </span>
                  {admin && (
                    <Button
                      size="xs"
                      variant="outline"
                      loading={restoring === domain.id}
                      disabled={restoring !== null}
                      onClick={async () => {
                        setRestoring(domain.id);
                        await run(async () => {
                          const result = await call("/domains/restore", { id: domain.id });
                          if (result.offBecause === "claimed") notifyInfo(`${domain.name} is back, but switched off. It's on somewhere else now.`);
                          else if (!result.enabled) notifyInfo(`${domain.name} is back, but switched off. Your plan has no room for another domain.`);
                        }, `${domain.name} restored`);
                        setRestoring(null);
                        refresh();
                      }}
                    >
                      Restore
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {admin && UpgradeHint && domainLimit !== null && enabled >= domainLimit && <UpgradeHint data={data} reason="domains" />}
        {admin && active.length > 0 && (
          <Button size="sm" variant="outline" loading={syncing} onClick={async () => { await runSync(() => call("/domains/sync"), "Domains updated"); refresh(); }}>
            Refresh domains
          </Button>
        )}
      </Section>

    </div>
  );
}

function RemoveDomainButton({ domain, data, refresh }: { domain: Domain; data: Bootstrap; refresh: () => void }) {
  const run = useRun();
  const connectionOf = (connectionId: string) => data.connections.find((c) => c.id === connectionId);
  const connection = connectionOf(domain.connectionId);
  const providerName = connection ? PROVIDER_INFO[connection.provider].name : "provider";
  const mailboxCount = data.managedMailboxes.filter((m) => m.domainId === domain.id).length;
  // Where the server moves the mailboxes: the same domain on another live connection, one that's on first.
  const successor = data.domains
    .filter((d) => d.id !== domain.id && d.name === domain.name && !d.removedAt && connectionOf(d.connectionId)?.status !== "disconnected")
    .sort((a, b) => Number(b.enabled) - Number(a.enabled))[0];
  const stopsReceiving =
    connection !== undefined && connection.provider !== "resend" && connection.status === "active" && domain.receivingEnabled;
  const mailboxes = `${mailboxCount} ${mailboxCount === 1 ? "mailbox" : "mailboxes"}`;
  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button size="icon-sm" variant="ghost" aria-label={`Remove ${domain.name}`} title="Remove from HelloBox" />}>
        <Trash />
      </AlertDialogTrigger>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {domain.name} from HelloBox?</AlertDialogTitle>
          <AlertDialogDescription render={<div />} className="space-y-2">
            <p>
              It stops counting toward your plan
              {stopsReceiving ? `, and ${providerName} stops sending its new mail to HelloBox` : ""}.
            </p>
            {mailboxCount > 0 && (
              <p>
                {successor
                  ? `Its ${mailboxes} move, with their mail, to ${domain.name} on ${connectionLabel(connectionOf(successor.connectionId))}.${successor.enabled ? "" : " That one is switched off, so their mail shows again once you switch it on."}`
                  : `Its ${mailboxes} and their mail stay here to read. You can't send from them until you add the domain again.`}
              </p>
            )}
            <p>{domain.name} stays in your {providerName} account ({connectionLabel(connection)}). Delete it there if you no longer need it.</p>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>Keep domain</AlertDialogClose>
          <AlertDialogClose
            render={<Button variant="destructive" />}
            onClick={async () => {
              await run(() => call("/domains/remove", { id: domain.id }), `${domain.name} removed`);
              refresh();
            }}
          >
            Remove domain
          </AlertDialogClose>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
