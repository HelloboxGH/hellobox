"use client";

import { Plugs, Robot } from "@phosphor-icons/react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Segmented } from "@/components/segmented";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { AGENT_SCOPE_LABELS, AGENT_SCOPES, AGENT_TOKEN_LIFETIMES, type AgentScope, normalizeScopes } from "@/core/agent-scopes";
import { type Bootstrap, call } from "@/core/client/api";
import { notifyError } from "@/core/client/notify";
import { CopyButton, Section, useRun } from "../shared";

type AgentConnection = Awaited<ReturnType<typeof call<"/agents/list">>>[number];
type NewAgentConnection = Awaited<ReturnType<typeof call<"/agents/create">>>;
type AgentClient = "claude-code" | "claude-desktop" | "other";

const AGENT_CLIENTS: { value: AgentClient; label: string }[] = [
  { value: "claude-code", label: "Claude Code" },
  { value: "claude-desktop", label: "Claude Desktop" },
  { value: "other", label: "Other clients" },
];

const LIFETIMES = AGENT_TOKEN_LIFETIMES.map((days) => ({
  value: String(days),
  label: days === 365 ? "1 year" : `${days} days`,
}));

export const formatDay = (value: Date | string) =>
  new Date(value).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

function agentSetup(client: AgentClient, url: string, token: string) {
  if (client === "claude-code") {
    return `claude mcp add --transport http hellobox ${url} \\\n  --header "Authorization: Bearer ${token}"`;
  }
  if (client === "claude-desktop") {
    return JSON.stringify(
      { mcpServers: { hellobox: { command: "npx", args: ["-y", "mcp-remote", url, "--header", `Authorization: Bearer ${token}`] } } },
      null,
      2,
    );
  }
  return JSON.stringify(
    { mcpServers: { hellobox: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } },
    null,
    2,
  );
}

const AGENT_SETUP_HINTS: Record<AgentClient, string> = {
  "claude-code": "Run this in a terminal. Add --scope user to use it in every project.",
  "claude-desktop": "Add this to claude_desktop_config.json under Settings, Developer, Edit config, then restart Claude.",
  other: "Most MCP clients, including Cursor and VS Code, take a remote server with a URL and headers like this.",
};

function AgentSetup({ token }: { token: string }) {
  const [client, setClient] = useState<AgentClient>("claude-code");
  // Only shown after creating a connection, so this never renders on the server.
  const url = `${window.location.origin}/api/mcp`;
  const snippet = agentSetup(client, url, token);
  return (
    <div className="space-y-3">
      <Segmented label="MCP client" value={client} onChange={setClient} options={AGENT_CLIENTS} />
      <p className="text-muted-foreground text-sm">{AGENT_SETUP_HINTS[client]}</p>
      <pre className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs leading-relaxed">{snippet}</pre>
      <div className="flex flex-wrap gap-2">
        <CopyButton value={snippet} />
        <CopyButton value={url} label="Copy server URL" />
      </div>
    </div>
  );
}

export function AgentsTab({ data }: { data: Bootstrap }) {
  const run = useRun();
  const [connections, setConnections] = useState<AgentConnection[] | null>(null);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<AgentScope[]>(["read", "write"]);
  const [days, setDays] = useState("90");
  const [created, setCreated] = useState<NewAgentConnection | null>(null);
  const load = useCallback(
    () => call("/agents/list").then(setConnections).catch((error: unknown) => notifyError(error)),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);
  const effective = normalizeScopes(scopes);
  const toggle = (scope: AgentScope, on: boolean) =>
    setScopes((current) => (on ? [...current, scope] : current.filter((item) => item !== scope)));

  return (
    <div className="space-y-4">
      <Section
        title="Agents"
        description={`Let AI agents like Claude use HelloBox for you over MCP. They act as you in ${data.workspace.name}, with your role and mailboxes and nothing more, and what they change shows up in the audit log.`}
      >
        {!connections ? (
          <Skeleton className="h-16 w-full rounded-xl" />
        ) : connections.length === 0 ? (
          <Empty className="py-6">
            <EmptyHeader>
              <EmptyMedia variant="icon"><Robot /></EmptyMedia>
              <EmptyTitle>No agents connected</EmptyTitle>
              <EmptyDescription>Create a connection below, then paste it into Claude or another MCP client.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="divide-y">
            {connections.map((connection) => (
              <li key={connection.id} className="flex flex-col gap-2 py-3 text-sm sm:flex-row sm:items-center sm:gap-x-3">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 font-medium text-foreground">
                    <span className="truncate">{connection.name}</span>
                    <code className="font-mono text-muted-foreground text-xs">…{connection.hint}</code>
                  </p>
                  <p className="text-muted-foreground text-xs tabular-nums">
                    {connection.lastUsedAt ? `Last used ${formatDay(connection.lastUsedAt)}` : "Never used"} · Expires {formatDay(connection.expiresAt)}
                  </p>
                </div>
                <div className="flex items-center justify-between gap-2">
                <div className="flex flex-wrap gap-1">
                  {connection.scopes.map((scope) => <Badge key={scope} variant="secondary" className="capitalize">{scope}</Badge>)}
                </div>
                <AlertDialog>
                  <AlertDialogTrigger render={<Button size="sm" variant="ghost" />}>Revoke</AlertDialogTrigger>
                  <AlertDialogPopup>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Revoke {connection.name}?</AlertDialogTitle>
                      <AlertDialogDescription>Anything using this connection loses access right away. Emails it already queued still send unless you cancel them.</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogClose render={<Button variant="ghost" />}>Keep it</AlertDialogClose>
                      <AlertDialogClose
                        render={<Button variant="destructive" />}
                        onClick={async () => {
                          if (await run(() => call("/agents/revoke", { id: connection.id }), "Connection revoked")) load();
                        }}
                      >
                        Revoke
                      </AlertDialogClose>
                    </AlertDialogFooter>
                  </AlertDialogPopup>
                </AlertDialog>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="New connection" description="You'll see the token once. Store it in your MCP client, not anywhere shared.">
        <Form
          className="space-y-4"
          onSubmit={async (event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            await run(async () => {
              const result = await call("/agents/create", {
                name,
                scopes: effective,
                days: Number(days) as (typeof AGENT_TOKEN_LIFETIMES)[number],
              });
              setCreated(result);
              setName("");
              load();
            });
          }}
        >
          <Field>
            <FieldLabel>Name</FieldLabel>
            <Input required maxLength={60} placeholder="Claude on my laptop" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <fieldset className="space-y-2">
            <legend className="mb-2 font-medium text-foreground text-sm">What it can do</legend>
            {AGENT_SCOPES.map((scope) => (
              <Label key={scope} className="flex items-start gap-2 font-normal">
                <Checkbox
                  className="mt-0.5"
                  checked={effective.includes(scope)}
                  disabled={scope === "read" || (scope === "write" && effective.includes("send"))}
                  onCheckedChange={(checked) => toggle(scope, Boolean(checked))}
                />
                <span>
                  <span className="font-medium text-foreground capitalize">{scope}</span>
                  <span className="block text-muted-foreground text-xs">{AGENT_SCOPE_LABELS[scope]}</span>
                </span>
              </Label>
            ))}
          </fieldset>
          <Field>
            <FieldLabel>Expires after</FieldLabel>
            <Select value={days} onValueChange={(value) => { if (value) setDays(value); }} items={LIFETIMES}>
              <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
              <SelectPopup>{LIFETIMES.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectPopup>
            </Select>
          </Field>
          <Button type="submit"><Plugs /> Create connection</Button>
        </Form>
      </Section>

      <Dialog open={created !== null} onOpenChange={(open) => { if (!open) setCreated(null); }}>
        <DialogPopup className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Connect {created?.name}</DialogTitle>
            <DialogDescription>Copy the token now. You won&apos;t be able to see it again.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-lg bg-muted p-2 font-mono text-xs">{created?.token}</code>
              {created && <CopyButton value={created.token} />}
            </div>
            {created && <AgentSetup token={created.token} />}
          </DialogPanel>
          <DialogFooter>
            <Button onClick={() => setCreated(null)}>Done</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
