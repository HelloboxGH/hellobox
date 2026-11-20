"use client";

import { ArrowClockwise, ArrowElbowDownRight, Check, HourglassMedium, Plus, Warning } from "@phosphor-icons/react";
import { type FormEvent, type ReactNode, useState } from "react";
import { groupDomains, subdomainProblem } from "@hellobox/mail/domain-names";
import { PROVIDER_INFO, type ProviderKind } from "@hellobox/providers/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { type Bootstrap, call } from "@/core/client/api";
import { notify, notifyInfo } from "@/core/client/notify";
import { CopyValue, DnsDialog, type DnsSetup, HOST_NAMES, needsHandAdding, useDnsTarget } from "./dns-records";
import { useRunning } from "./shared";

type Connection = Bootstrap["connections"][number];
type Domain = Bootstrap["domains"][number];

// How receiving looks for one domain. waiting: turned on, and the provider doesn't take it
// until it sees the MX record. blocked: why the switch can't turn it on.
export type Receiving = { on: boolean; waiting?: boolean; blocked?: string };

// A connection's domains, each subdomain under its parent. The same for every provider:
// status, DNS records, "Check again", receiving, and receiving on a subdomain.
export function DomainList({ connection, data, admin, refresh, receiving, setReceiving, canAdd, emptyText, children }: {
  connection: Connection;
  data: Bootstrap;
  admin: boolean;
  refresh: () => void;
  receiving: (domain: Domain) => Receiving;
  // Turns receiving on or off and returns the MX records' setup. Left out where the
  // provider's own dashboard does it.
  setReceiving?: (domain: string, on: boolean) => Promise<DnsSetup | null>;
  canAdd: boolean;
  emptyText: string;
  children?: ReactNode;
}) {
  const domains = data.domains.filter((domain) => domain.connectionId === connection.id && !domain.removedAt);
  const grouped = groupDomains(domains);
  const [newDomain, setNewDomain] = useState("");
  const [adding, setAdding] = useState(false);
  const [dns, setDns] = useDnsTarget(connection.id);
  const [savingReceiving, setSavingReceiving] = useState<string | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [subdomainFor, setSubdomainFor] = useState<string | null>(null);
  const [guide, setGuide] = useState<{ parent: string; subdomain: string } | null>(null);
  const [addingDomain, runAdd] = useRunning();
  const [, runReceiving] = useRunning();
  const [, runCheck] = useRunning();
  const provider = PROVIDER_INFO[connection.provider].name;

  async function toggleReceiving(domain: string, on: boolean) {
    if (!setReceiving) return;
    setSavingReceiving(domain);
    await runReceiving(async () => {
      const setup = await setReceiving(domain, on);
      // Show the MX record unless the DNS host already has it.
      if (on && setup && needsHandAdding(setup)) setDns({ domain, setup });
    }, on ? `Receiving is on for ${domain}` : `Receiving is off for ${domain}`);
    setSavingReceiving(null);
    refresh();
  }

  async function check(domain: Domain) {
    setChecking(domain.name);
    await runCheck(async () => {
      const result = await call("/connections/domains/refresh", { connectionId: connection.id, domain: domain.name });
      if (result.status !== "verified") {
        notifyInfo(`${provider} doesn't see the records for ${domain.name} yet. DNS changes can take up to an hour.`);
      } else if (receiving(domain).waiting) {
        notifyInfo(`${domain.name} is verified. Receiving starts once ${provider} sees the MX record.`);
      } else if (receiving(domain).on && !domain.hasMail) {
        notifyInfo(`${domain.name} is ready. No email has arrived yet: send one to any address at ${domain.name} to try it.`);
      } else {
        notify(`${domain.name} is verified`);
      }
    });
    setChecking(null);
    refresh();
  }

  return (
    <>
      <div className="flex items-center justify-between px-1 pt-1">
        <p className="font-medium text-foreground text-sm">Domains <span className="text-muted-foreground tabular-nums">{domains.length}</span></p>
        {admin && canAdd && !adding && <Button size="xs" variant="ghost" onClick={() => setAdding(true)}><Plus /> Add domain</Button>}
      </div>
      {admin && adding && (
        <Form
          className="flex gap-2"
          onSubmit={async (event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            const domain = newDomain.trim().toLowerCase();
            const done = await runAdd(async () => {
              const setup = await call("/connections/domains/add", { connectionId: connection.id, domain });
              setNewDomain("");
              setDns({ domain, setup });
            }, `${domain} added`);
            if (done) setAdding(false);
            refresh();
          }}
        >
          <Input autoFocus required aria-label="Domain" placeholder="yourdomain.com" value={newDomain} disabled={addingDomain} onChange={(e) => setNewDomain(e.target.value)} />
          <Button type="submit" loading={addingDomain}>Add</Button>
          <Button type="button" variant="ghost" disabled={addingDomain} onClick={() => { setAdding(false); setNewDomain(""); }}>Cancel</Button>
        </Form>
      )}
      <ul className="divide-y rounded-xl border">
        {grouped.map(({ domain, parent }, index) => {
          const verified = domain.status === "verified";
          const state = receiving(domain);
          const waitingForMail = state.on && !state.waiting && !domain.hasMail;
          // The subdomain offer closes each group: after a domain and its subdomains, when
          // none of them receives yet.
          const groupRoot = parent ?? domain.name;
          const lastOfGroup = (grouped[index + 1]?.parent ?? grouped[index + 1]?.domain.name) !== groupRoot;
          const groupReceives = grouped.some((row) => (row.parent ?? row.domain.name) === groupRoot && receiving(row.domain).on);
          return (
            <li key={domain.id}>
              <div className={`flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 ${parent ? "ps-8" : ""}`}>
                <span className="flex min-w-0 flex-1 basis-44 flex-wrap items-center gap-2">
                  {parent && <ArrowElbowDownRight className="-ms-5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
                  <span className="truncate font-medium text-foreground text-sm">{domain.name}</span>
                  {verified
                    ? <Badge variant="success" size="sm">Verified</Badge>
                    : <Badge variant="warning" size="sm">Waiting for DNS</Badge>}
                  {state.waiting && <Badge variant="warning" size="sm">Receiving waits for the MX</Badge>}
                  {waitingForMail && <Badge variant="info" size="sm"><HourglassMedium /> Waiting for the first email…</Badge>}
                  {state.on && domain.hasMail && <Badge variant="outline" size="sm">Receiving</Badge>}
                </span>
                <span className="ms-auto flex shrink-0 items-center gap-2">
                  {admin && (!verified || state.waiting || waitingForMail) && (
                    <Button
                      size="xs"
                      variant="ghost"
                      loading={checking === domain.name}
                      disabled={checking !== null}
                      title="Ask the provider to check the DNS again"
                      onClick={() => check(domain)}
                    >
                      <ArrowClockwise /> Check again
                    </Button>
                  )}
                  {parent && state.on && (
                    <Button size="xs" variant="ghost" onClick={() => setGuide({ parent, subdomain: domain.name })}>Reply-To</Button>
                  )}
                  {verified || !admin ? (
                    <Button size="xs" variant="ghost" onClick={() => setDns({ domain: domain.name, setup: null })}>Records</Button>
                  ) : (
                    <Button size="xs" variant="outline" onClick={() => setDns({ domain: domain.name, setup: null, autoApply: true })}>Add DNS records</Button>
                  )}
                  {admin && setReceiving && (
                    <Switch
                      aria-label={`Receive mail for ${domain.name}`}
                      title={state.blocked ?? "Receive mail for this domain"}
                      checked={state.on || Boolean(state.waiting)}
                      disabled={savingReceiving !== null || (Boolean(state.blocked) && !state.on && !state.waiting)}
                      onCheckedChange={(checked) => toggleReceiving(domain.name, checked)}
                    />
                  )}
                </span>
              </div>
              {admin && lastOfGroup && !groupReceives && (
                <div className="px-3 pb-2 ps-8">
                  <Button size="xs" variant="ghost" className="-ms-2 text-muted-foreground" onClick={() => setSubdomainFor(groupRoot)}>
                    <Plus /> Receive replies on a subdomain
                  </Button>
                </div>
              )}
            </li>
          );
        })}
        {domains.length === 0 && <li className="px-3 py-3 text-muted-foreground text-sm">{emptyText}</li>}
      </ul>
      {children}
      <DnsDialog
        connection={connection}
        workspaceId={data.workspace.id}
        target={dns}
        admin={admin}
        onClose={() => setDns(null)}
        onChanged={refresh}
      />
      <SubdomainDialog
        connection={connection}
        data={data}
        parent={subdomainFor}
        onClose={() => setSubdomainFor(null)}
        onShowRecords={(domain, setup) => { setSubdomainFor(null); setDns({ domain, setup }); }}
        refresh={refresh}
      />
      <Dialog open={guide !== null} onOpenChange={(open) => { if (!open) setGuide(null); }}>
        <DialogPopup className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Send replies to {guide?.subdomain}</DialogTitle>
            <DialogDescription>Keep sending from {guide?.parent}, and set a Reply-To so replies land here.</DialogDescription>
          </DialogHeader>
          <DialogPanel>{guide && <ReplyToGuide provider={connection.provider} parent={guide.parent} subdomain={guide.subdomain} />}</DialogPanel>
          <DialogFooter><Button onClick={() => setGuide(null)}>Done</Button></DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}

const PROVIDER_STEP: Record<ProviderKind, (subdomain: string) => string> = {
  ses: (subdomain) => `We add ${subdomain} to Amazon SES and to your receipt rule.`,
  resend: (subdomain) => `We add ${subdomain} to Resend with receiving on.`,
  postmark: (subdomain) => `We add ${subdomain} to Postmark and make it this server's inbound domain.`,
  mailgun: (subdomain) => `We add ${subdomain} to Mailgun, with a route that sends its mail to HelloBox.`,
  demo: () => "Not available in the demo.",
};

function SubdomainDialog({ connection, data, parent, onClose, onShowRecords, refresh }: {
  connection: Connection;
  data: Bootstrap;
  parent: string | null;
  onClose: () => void;
  onShowRecords: (domain: string, setup: DnsSetup) => void;
  refresh: () => void;
}) {
  return (
    <Dialog open={parent !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogPopup className="sm:max-w-xl">
        {parent && (
          <SubdomainSetup
            key={parent}
            connection={connection}
            data={data}
            parent={parent}
            onClose={onClose}
            onShowRecords={onShowRecords}
            refresh={refresh}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}

function SubdomainSetup({ connection, data, parent, onClose, onShowRecords, refresh }: {
  connection: Connection;
  data: Bootstrap;
  parent: string;
  onClose: () => void;
  onShowRecords: (domain: string, setup: DnsSetup) => void;
  refresh: () => void;
}) {
  const [name, setName] = useState(`reply.${parent}`);
  const [done, setDone] = useState<{ subdomain: string; setup: DnsSetup; waiting: boolean } | null>(null);
  const [settingUp, runSetup] = useRunning();
  const subdomain = name.trim().toLowerCase().replace(/\.$/, "");
  const problem = subdomain ? subdomainProblem(parent, subdomain) : null;
  // A Postmark server receives for one domain, so another one receiving blocks this.
  const postmarkBusy =
    connection.provider === "postmark" ? connection.inboundDomain ?? connection.pendingInboundDomain : null;
  const dnsHost = connection.route53 ? "Route 53 or Cloudflare" : data.dnsHosts.cloudflare ? "Cloudflare" : null;

  if (done) {
    const byHand = needsHandAdding(done.setup);
    return (
      <>
        <DialogHeader>
          <DialogTitle>{done.subdomain} is set up</DialogTitle>
          <DialogDescription>{parent}&apos;s own MX records weren&apos;t touched.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          {byHand ? (
            <Alert variant="warning" className="rounded-xl">
              <Warning />
              <AlertDescription>
                Add {done.setup.records.length - done.setup.applied.length} DNS records for {done.subdomain} where your DNS is hosted. Mail starts arriving once they&apos;re live.
              </AlertDescription>
            </Alert>
          ) : (
            <Alert variant="success" className="rounded-xl">
              <Check />
              <AlertDescription>
                DNS records added{done.setup.appliedTo ? ` to ${HOST_NAMES[done.setup.appliedTo]}` : ""}. {PROVIDER_INFO[connection.provider].name} checks them by itself, usually within minutes.
              </AlertDescription>
            </Alert>
          )}
          {done.waiting && (
            <Alert variant="info" className="rounded-xl">
              <HourglassMedium />
              <AlertDescription>
                Postmark only starts receiving once it sees the MX record. HelloBox asks again every minute. Mail sent before then bounces, so wait for the domain to show &quot;Waiting for the first email&quot; before you use it.
              </AlertDescription>
            </Alert>
          )}
          <ReplyToGuide provider={connection.provider} parent={parent} subdomain={done.subdomain} />
        </DialogPanel>
        <DialogFooter>
          {byHand && <Button variant="outline" onClick={() => onShowRecords(done.subdomain, done.setup)}>Show DNS records</Button>}
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <Form
      className="contents"
      onSubmit={async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (problem) return;
        await runSetup(async () => {
          const result = await call("/connections/domains/receive-subdomain", { connectionId: connection.id, parent, subdomain });
          setDone({ subdomain, ...result });
        });
        refresh();
      }}
    >
      <DialogHeader>
        <DialogTitle>Receive replies on a subdomain</DialogTitle>
        <DialogDescription>
          Replies go to an address like support@reply.{parent}, so {parent}&apos;s own mail, often Google Workspace, stays where it is.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="space-y-4">
        <Field>
          <FieldLabel>Subdomain</FieldLabel>
          <Input autoFocus required value={name} disabled={settingUp} onChange={(e) => setName(e.target.value)} aria-invalid={Boolean(problem)} />
          {problem ? <FieldError match>{problem}</FieldError> : <FieldDescription>Mail to any address here comes to HelloBox.</FieldDescription>}
        </Field>
        {postmarkBusy && postmarkBusy !== subdomain && (
          <Alert variant="warning" className="rounded-xl">
            <Warning />
            <AlertDescription>
              A Postmark server receives mail for one domain, and this one already receives for {postmarkBusy}. Turn receiving off there first, or connect another Postmark server for {subdomain || "the subdomain"}.
            </AlertDescription>
          </Alert>
        )}
        <ul className="space-y-1.5 rounded-xl bg-muted/60 p-3 text-muted-foreground text-xs">
          <li>• {PROVIDER_STEP[connection.provider](subdomain || `reply.${parent}`)} You can send replies from it too.</li>
          <li>• {dnsHost ? `Its DNS records go into ${dnsHost} for you when ${parent} is there; otherwise you get them to copy.` : "You get its DNS records to copy into your DNS provider."} Only records under the subdomain are added.</li>
          <li>• {parent}&apos;s MX records are never changed, so the mail it gets today keeps arriving where it does.</li>
          <li>• It counts under {parent} on your plan, not as another domain.</li>
        </ul>
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="ghost" disabled={settingUp} onClick={onClose}>Cancel</Button>
        <Button type="submit" loading={settingUp} disabled={Boolean(problem) || Boolean(postmarkBusy && postmarkBusy !== subdomain)}>
          Set up {subdomain || "subdomain"}
        </Button>
      </DialogFooter>
    </Form>
  );
}

// What to set on outgoing mail, for the SDK of the provider they send with.
function replyToSnippet(provider: ProviderKind, parent: string, address: string) {
  switch (provider) {
    case "resend":
      return `await resend.emails.send({
  from: "Acme <hello@${parent}>",
  to: customer.email,
  replyTo: "${address}",
  subject,
  html,
});`;
    case "postmark":
      return `await postmark.sendEmail({
  From: "hello@${parent}",
  To: customer.email,
  ReplyTo: "${address}",
  Subject: subject,
  HtmlBody: html,
});`;
    case "mailgun":
      return `await mailgun.messages.create("${parent}", {
  from: "Acme <hello@${parent}>",
  to: customer.email,
  "h:Reply-To": "${address}",
  subject,
  html,
});`;
    case "ses":
      return `await ses.send(new SendEmailCommand({
  FromEmailAddress: "Acme <hello@${parent}>",
  Destination: { ToAddresses: [customer.email] },
  ReplyToAddresses: ["${address}"],
  Content: { Simple: { Subject: { Data: subject }, Body: { Html: { Data: html } } } },
}));`;
    case "demo":
      return `// Sign up free to receive replies on your own domain.`;
  }
}

function ReplyToGuide({ provider, parent, subdomain }: { provider: ProviderKind; parent: string; subdomain: string }) {
  const [local, setLocal] = useState("support");
  const address = `${local.trim() || "support"}@${subdomain}`;
  const snippet = replyToSnippet(provider, parent, address);
  return (
    <div className="space-y-3">
      <p className="font-medium text-foreground text-sm">Use it in your app</p>
      <Field>
        <FieldLabel>Reply-To address</FieldLabel>
        <span className="flex w-full items-center gap-1">
          <Input aria-label="Address name" className="max-w-40" value={local} onChange={(e) => setLocal(e.target.value)} />
          <span className="min-w-0 truncate text-muted-foreground text-sm">@{subdomain}</span>
        </span>
        <FieldDescription>
          Keep sending from {parent}. Replies to {address} land in a {address} mailbox here, and answers you send from it come from that address.
        </FieldDescription>
      </Field>
      <div className="relative">
        <pre className="overflow-x-auto rounded-xl bg-muted/60 p-3 pe-10 font-mono text-xs leading-relaxed">{snippet}</pre>
        <span className="absolute end-1.5 top-1.5"><CopyValue value={snippet} /></span>
      </div>
      <p className="text-muted-foreground text-xs">
        Sending some other way? Set the header <code className="font-mono">Reply-To: {address}</code>.
      </p>
    </div>
  );
}
