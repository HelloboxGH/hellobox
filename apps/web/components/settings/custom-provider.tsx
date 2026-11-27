"use client";

import { Code, Copy, Key, Lightning, Plus, Robot, Sparkle, Trash, Warning } from "@phosphor-icons/react";
import {
  buildRequest,
  checkSpec,
  customSpecPrompt,
  type CustomSpec,
  likelyKeys,
  replaceValue,
  SAMPLE_MESSAGE,
  secretNames,
  specFromAnswer,
  specFromCurl,
} from "@hellobox/providers/custom";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { call } from "@/core/client/api";
import { notify } from "@/core/client/notify";
import { useRun } from "./shared";

// The spec as it's being edited: maybe not valid yet, so loosely typed.
type Draft = Record<string, unknown> & { name?: string; send?: Record<string, unknown> };
type Json = unknown;

const EXAMPLE_CURL = `curl https://api.acme.example/v1/send \\
  -H 'Authorization: Bearer <API_KEY>' \\
  --json '{"from": "{{from}}", "to": "{{to | emails}}", "subject": "{{subject}}", "html": "{{html}}"}'`;

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"].map((value) => ({ value, label: value }));
const BODY_TYPES = [
  { value: "none", label: "No body" },
  { value: "json", label: "JSON" },
  { value: "form", label: "Form" },
  { value: "multipart", label: "Multipart (files)" },
  { value: "text", label: "Text" },
];

// The message fields, with the formats people need most.
const INSERTS: { label: string; items: [string, string][] }[] = [
  { label: "From", items: [["{{from}}", "Name <address>"], ["{{from | email}}", "Address"], ["{{from | name}}", "Name"], ["{{from | object email name}}", "{ email, name }"]] },
  {
    label: "To",
    items: [["{{to}}", "List of Name <address>"], ["{{to | emails}}", "List of addresses"], ["{{to | csv}}", "Comma-separated"], ["{{to | objects email name}}", "List of { email, name }"], ["{{to | first email}}", "First address"]],
  },
  { label: "Cc and Bcc", items: [["{{cc | emails}}", "Cc addresses"], ["{{cc | objects email name}}", "Cc as { email, name }"], ["{{bcc | emails}}", "Bcc addresses"], ["{{bcc | objects email name}}", "Bcc as { email, name }"]] },
  { label: "Reply-To", items: [["{{replyTo | first email}}", "First address"], ["{{replyTo | emails}}", "List of addresses"]] },
  { label: "Content", items: [["{{subject}}", "Subject"], ["{{html}}", "HTML"], ["{{text}}", "Plain text"]] },
  {
    label: "Headers and more",
    items: [
      ["{{headers | map}}", "Headers as { name: value }"],
      ["{{headers | list name value}}", "Headers as [{ name, value }]"],
      ["{{attachments | objects filename content contentType}}", "Attachments (base64)"],
      ["{{tags | map}}", "Tags"],
      ["{{messageId}}", "Message-ID"],
      ["{{idempotencyKey}}", "Idempotency key"],
      ["{{mime | base64}}", "Whole message, base64"],
    ],
  },
];

const isObject = (value: unknown): value is Record<string, Json> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// One value in the body: text with an insert menu, a list, or an object of fields.
function ValueEditor({ value, onChange, onRemove }: { value: Json; onChange: (value: Json) => void; onRemove?: () => void }) {
  const remove = onRemove && (
    <Button type="button" size="icon-sm" variant="ghost" aria-label="Remove" onClick={onRemove}><Trash /></Button>
  );
  if (Array.isArray(value)) {
    return (
      <div className="space-y-1.5 border-l pl-3">
        <div className="flex items-center gap-1 text-muted-foreground text-xs">List {remove}</div>
        {value.map((item, index) => (
          <ValueEditor
            key={index}
            value={item}
            onChange={(next) => onChange(value.map((old, i) => (i === index ? next : old)))}
            onRemove={() => onChange(value.filter((_, i) => i !== index))}
          />
        ))}
        <Button type="button" size="xs" variant="ghost" onClick={() => onChange([...value, ""])}><Plus /> Add item</Button>
      </div>
    );
  }
  if (isObject(value)) {
    const entries = Object.entries(value);
    const rename = (from: string, to: string) =>
      onChange(Object.fromEntries(entries.map(([key, item]) => [key === from ? to : key, item])));
    return (
      <div className="space-y-1.5 border-l pl-3">
        {onRemove && <div className="flex items-center gap-1 text-muted-foreground text-xs">Object {remove}</div>}
        {entries.map(([key, item], index) => (
          <div key={index} className="flex flex-col gap-1.5 sm:flex-row sm:items-start">
            <Input
              aria-label="Field name"
              className="font-mono text-xs sm:w-36 sm:shrink-0"
              value={key}
              onChange={(event) => rename(key, event.target.value)}
            />
            <div className="min-w-0 flex-1">
              <ValueEditor
                value={item}
                onChange={(next) => onChange({ ...value, [key]: next })}
                onRemove={() => onChange(Object.fromEntries(entries.filter(([other]) => other !== key)))}
              />
            </div>
          </div>
        ))}
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={() => {
            let name = "field";
            for (let n = 2; name in value; n++) name = `field${n}`;
            onChange({ ...value, [name]: "" });
          }}
        >
          <Plus /> Add field
        </Button>
      </div>
    );
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (
    <div className="flex items-center gap-1">
      <Input
        aria-label="Value"
        className="font-mono text-xs"
        value={text}
        onChange={(event) => {
          if (typeof value === "string") return onChange(event.target.value);
          // Numbers, true and false stay what they are while they still parse.
          try {
            onChange(JSON.parse(event.target.value));
          } catch {
            onChange(event.target.value);
          }
        }}
      />
      <Menu>
        <MenuTrigger render={<Button type="button" size="icon-sm" variant="ghost" aria-label="Use a message field" />}><Sparkle /></MenuTrigger>
        <MenuPopup align="end" className="max-h-96 overflow-y-auto">
          {INSERTS.map((group) => (
            <MenuGroup key={group.label}>
              <MenuGroupLabel>{group.label}</MenuGroupLabel>
              {group.items.map(([placeholder, label]) => (
                <MenuItem key={placeholder} onClick={() => onChange(placeholder)}>
                  <span className="flex-1">{label}</span>
                  <span className="font-mono text-muted-foreground text-xs">{placeholder.replace(/^\{\{|\}\}$/g, "")}</span>
                </MenuItem>
              ))}
            </MenuGroup>
          ))}
          <MenuSeparator />
          <MenuItem onClick={() => onChange([text])}>Make it a list</MenuItem>
          <MenuItem onClick={() => onChange({ field: text })}>Make it an object</MenuItem>
        </MenuPopup>
      </Menu>
      {remove}
    </div>
  );
}

function SpecEditor({ spec, onChange }: { spec: Draft; onChange: (spec: Draft) => void }) {
  const send = (spec.send ?? {}) as Record<string, Json>;
  const headers = isObject(send.headers) ? (send.headers as Record<string, string>) : {};
  const body = isObject(send.body) ? (send.body as { type?: string; content?: Json }) : null;
  const response = isObject(send.response) ? (send.response as { id?: string }) : {};
  const setSend = (patch: Record<string, Json>) => onChange({ ...spec, send: { ...send, ...patch } });
  const headerRows = Object.entries(headers);

  return (
    <div className="space-y-4">
      <Field>
        <FieldLabel>Name</FieldLabel>
        <Input value={spec.name ?? ""} onChange={(event) => onChange({ ...spec, name: event.target.value })} placeholder="Acme Mail" />
      </Field>
      <Field>
        <FieldLabel>Request</FieldLabel>
        <div className="flex w-full gap-2">
          <Select value={String(send.method ?? "POST")} items={METHODS} onValueChange={(value) => value && setSend({ method: value })}>
            <SelectTrigger aria-label="Method" className="w-28 shrink-0"><SelectValue /></SelectTrigger>
            <SelectPopup>{METHODS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectPopup>
          </Select>
          <Input
            aria-label="Address"
            className="font-mono text-xs"
            value={String(send.url ?? "")}
            onChange={(event) => setSend({ url: event.target.value })}
            placeholder="https://api.example.com/v1/send"
          />
        </div>
      </Field>
      <Field>
        <FieldLabel>Headers</FieldLabel>
        <div className="w-full space-y-1.5">
          {headerRows.map(([name, value], index) => (
            <div key={index} className="flex gap-1.5">
              <Input
                aria-label="Header name"
                className="font-mono text-xs sm:w-44"
                value={name}
                onChange={(event) => setSend({ headers: Object.fromEntries(headerRows.map(([key, item]) => [key === name ? event.target.value : key, item])) })}
              />
              <Input
                aria-label="Header value"
                className="font-mono text-xs"
                value={value}
                onChange={(event) => setSend({ headers: { ...headers, [name]: event.target.value } })}
              />
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Remove header"
                onClick={() => setSend({ headers: Object.fromEntries(headerRows.filter(([key]) => key !== name)) })}
              >
                <Trash />
              </Button>
            </div>
          ))}
          <Button type="button" size="xs" variant="ghost" onClick={() => setSend({ headers: { ...headers, "X-Header": "" } })}><Plus /> Add header</Button>
        </div>
      </Field>
      {isObject(send.auth) && (
        <Field>
          <FieldLabel>Basic sign-in</FieldLabel>
          <div className="flex w-full gap-2">
            <Input
              aria-label="Username"
              className="font-mono text-xs"
              value={String((send.auth as Record<string, Json>).username ?? "")}
              onChange={(event) => setSend({ auth: { ...(send.auth as object), username: event.target.value } })}
            />
            <Input
              aria-label="Password"
              className="font-mono text-xs"
              value={String((send.auth as Record<string, Json>).password ?? "")}
              onChange={(event) => setSend({ auth: { ...(send.auth as object), password: event.target.value } })}
            />
          </div>
        </Field>
      )}
      <Field>
        <FieldLabel>Body</FieldLabel>
        <Select
          value={body?.type ?? "none"}
          items={BODY_TYPES}
          onValueChange={(value) => {
            if (!value) return;
            if (value === "none") return setSend({ body: undefined });
            const content = value === "text" ? (typeof body?.content === "string" ? body.content : "") : isObject(body?.content) ? body.content : {};
            setSend({ body: { type: value, content } });
          }}
        >
          <SelectTrigger aria-label="Body type" className="w-48"><SelectValue /></SelectTrigger>
          <SelectPopup>{BODY_TYPES.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectPopup>
        </Select>
        {body?.type === "text" && (
          <Textarea
            className="font-mono text-xs"
            value={typeof body.content === "string" ? body.content : ""}
            onChange={(event) => setSend({ body: { ...body, content: event.target.value } })}
          />
        )}
        {body && body.type !== "text" && (
          <div className="w-full">
            <ValueEditor value={body.content ?? {}} onChange={(content) => setSend({ body: { ...body, content } })} />
          </div>
        )}
        <FieldDescription>Use the sparkle on a value to put a part of the email there, in the shape your provider wants.</FieldDescription>
      </Field>
      <Field>
        <FieldLabel>Where the message id is in the answer</FieldLabel>
        <Input
          className="font-mono text-xs"
          value={response.id ?? ""}
          placeholder="data.id, or header:X-Message-Id"
          onChange={(event) => setSend({ response: event.target.value ? { id: event.target.value } : undefined })}
        />
        <FieldDescription>Optional. Without it, the email&apos;s own Message-ID is used.</FieldDescription>
      </Field>
    </div>
  );
}

// The request for a sample email, with each <NAME> left as it is.
function usePreview(spec: CustomSpec | null) {
  const [preview, setPreview] = useState("");
  useEffect(() => {
    if (!spec) return;
    let cancelled = false;
    const names = Object.fromEntries(secretNames(spec).map((name) => [name, `<${name}>`]));
    buildRequest(spec.send, { secrets: names, message: SAMPLE_MESSAGE })
      .then((request) => {
        let url = request.url;
        try {
          url = decodeURIComponent(request.url);
        } catch {}
        const headers = Object.entries(request.headers).map(([key, value]) => `${key}: ${value}`).join("\n");
        let body = request.body ? new TextDecoder().decode(request.body) : "";
        if (request.headers["Content-Type"]?.includes("json")) {
          try {
            body = JSON.stringify(JSON.parse(body), null, 2);
          } catch {}
        }
        if (!cancelled) setPreview(`${request.method} ${url}\n${headers}${body ? `\n\n${body.slice(0, 4000)}` : ""}`);
      })
      .catch((error: unknown) => !cancelled && setPreview(`Can't build the request: ${error instanceof Error ? error.message : String(error)}`));
    return () => {
      cancelled = true;
    };
  }, [spec]);
  return spec ? preview : "";
}

type TestResult = { ok: boolean; status: number; body: string; id: string | null; idFound: boolean | null; error: string | null };

// Every way into a spec (a curl command, the editor, JSON), then a value for each <NAME>, a
// test send, and saving. The values are sealed when saved and never shown again; on
// reconnect, empty ones keep what was saved.
export function CustomConnectDialog({ open, onOpenChange, reconnectId, initialSpec, refresh, defaultFrom }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reconnectId?: string;
  // The saved spec, when editing one.
  initialSpec?: Record<string, unknown>;
  refresh: () => void;
  // A sending address to test from, such as the first mailbox.
  defaultFrom?: string;
}) {
  const run = useRun();
  const [tab, setTab] = useState(initialSpec ? "editor" : "curl");
  const [curl, setCurl] = useState("");
  const [curlError, setCurlError] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [answerError, setAnswerError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>((initialSpec as Draft | undefined) ?? null);
  const [json, setJson] = useState(initialSpec ? JSON.stringify(initialSpec, null, 2) : "");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [from, setFrom] = useState(defaultFrom ?? "");
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ result: TestResult; key: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const check = useMemo(() => (draft ? checkSpec(draft) : null), [draft]);
  const spec = check?.ok ? check.spec : null;
  const preview = usePreview(spec);
  const keys = useMemo(() => (draft ? likelyKeys(draft) : []), [draft]);
  const current = JSON.stringify([draft, values]);
  const tested = test?.result.ok && test.key === current;

  function applyDraft(next: Draft, switchTo?: string) {
    setDraft(next);
    setJson(JSON.stringify(next, null, 2));
    setJsonError(null);
    if (switchTo) setTab(switchTo);
  }

  function readCurl() {
    try {
      applyDraft(specFromCurl(curl) as Draft, "editor");
      setCurlError(null);
    } catch (error) {
      setCurlError(error instanceof Error ? error.message : String(error));
    }
  }

  async function copyPrompt() {
    await run(() => navigator.clipboard.writeText(customSpecPrompt()), "Prompt copied. Paste it into your AI, with your provider's API docs under it.");
  }

  function readAnswer() {
    try {
      const parsed = specFromAnswer(answer);
      if (!isObject(parsed)) throw new Error("The answer isn't a JSON object");
      applyDraft(parsed as Draft, "editor");
      setAnswerError(null);
    } catch (error) {
      setAnswerError(error instanceof Error ? error.message : String(error));
    }
  }

  // A key pasted by mistake moves into the sealed values, and the spec gets its name.
  function sealKey(value: string) {
    if (!draft) return;
    const taken = new Set(check?.ok ? check.secrets : []);
    let name = "API_KEY";
    for (let n = 2; taken.has(name); n++) name = `API_KEY_${n}`;
    applyDraft(replaceValue(draft, value, `<${name}>`));
    setValues((old) => ({ ...old, [name]: value }));
  }

  async function sendTest() {
    if (!spec) return;
    setTesting(true);
    const key = current;
    await run(async () => {
      const result = await call("/connections/custom/test", { spec, values, connectionId: reconnectId, from });
      setTest({ result, key });
    });
    setTesting(false);
  }

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!spec || !tested) return;
    setBusy(true);
    const done = await run(() => call("/connections/custom/connect", { spec, values, connectionId: reconnectId }));
    setBusy(false);
    if (!done) return;
    notify(reconnectId ? `${spec.name} is connected again` : `${spec.name} is connected. Add the domains you send from.`);
    setDraft(null);
    setCurl("");
    setJson("");
    setValues({});
    setTest(null);
    setTab("curl");
    refresh();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{initialSpec ? `Edit ${String(initialSpec.name ?? "custom provider")}` : "Connect a custom provider"}</DialogTitle>
          <DialogDescription>
            Describe how your provider sends an email. Use {"<NAME>"} for your keys, which you type below and we store encrypted, and the
            sparkle menu (or {"{{field}}"}) for the parts of each email.
          </DialogDescription>
        </DialogHeader>
        <Form className="contents" onSubmit={connect}>
          <DialogPanel className="space-y-5">
            <Tabs value={tab} onValueChange={(value) => setTab(String(value))}>
              <TabsList>
                <TabsTab value="curl"><Lightning /> Paste curl</TabsTab>
                <TabsTab value="ai"><Robot /> Ask your AI</TabsTab>
                <TabsTab value="editor" disabled={!draft}>Editor</TabsTab>
                <TabsTab value="json"><Code /> JSON</TabsTab>
              </TabsList>
              <TabsPanel value="curl" className="space-y-2 pt-3">
                <Textarea
                  value={curl}
                  onChange={(event) => setCurl(event.target.value)}
                  placeholder={EXAMPLE_CURL}
                  spellCheck={false}
                  className="min-h-40 font-mono text-xs"
                />
                {curlError && <p className="text-destructive-foreground text-xs">{curlError}</p>}
                <p className="text-muted-foreground text-xs">
                  Copy the send example from your provider&apos;s API docs. Put {"<API_KEY>"} where the key goes.
                </p>
                <Button type="button" variant="outline" disabled={!curl.trim()} onClick={readCurl}>Read the command</Button>
              </TabsPanel>
              <TabsPanel value="ai" className="space-y-2 pt-3">
                <ol className="list-decimal space-y-1 pl-4 text-muted-foreground text-sm">
                  <li>Copy the prompt, and paste it into ChatGPT, Claude or any AI you use.</li>
                  <li>Under it, paste your provider&apos;s API docs for sending an email (and for webhooks, to get delivery events).</li>
                  <li>Paste the AI&apos;s answer here. It never needs your real keys.</li>
                </ol>
                <Button type="button" variant="outline" onClick={copyPrompt}><Copy /> Copy prompt</Button>
                <Textarea
                  value={answer}
                  onChange={(event) => setAnswer(event.target.value)}
                  placeholder="The AI's answer"
                  spellCheck={false}
                  className="min-h-40 font-mono text-xs"
                />
                {answerError && <p className="text-destructive-foreground text-xs">{answerError}</p>}
                <Button type="button" variant="outline" disabled={!answer.trim()} onClick={readAnswer}>Read the answer</Button>
              </TabsPanel>
              <TabsPanel value="editor" className="pt-3">
                {draft && <SpecEditor spec={draft} onChange={(next) => applyDraft(next)} />}
              </TabsPanel>
              <TabsPanel value="json" className="space-y-2 pt-3">
                <Textarea
                  value={json}
                  onChange={(event) => {
                    setJson(event.target.value);
                    try {
                      const parsed = JSON.parse(event.target.value) as unknown;
                      if (!isObject(parsed)) throw new Error("The spec is a JSON object, between { and }");
                      setDraft(parsed as Draft);
                      setJsonError(null);
                    } catch (error) {
                      setJsonError(error instanceof Error ? error.message : String(error));
                    }
                  }}
                  spellCheck={false}
                  placeholder='{ "version": 1, "name": "Acme Mail", "send": { … } }'
                  className="min-h-72 font-mono text-xs"
                />
                {jsonError && json.trim() && <p className="text-destructive-foreground text-xs">That isn&apos;t valid JSON yet: {jsonError}</p>}
              </TabsPanel>
            </Tabs>

            {check && !check.ok && (
              <Alert variant="warning" className="rounded-xl">
                <Warning />
                <AlertDescription>
                  <ul className="list-disc space-y-0.5 pl-4">
                    {check.problems.slice(0, 8).map((problem) => <li key={problem}>{problem}</li>)}
                  </ul>
                </AlertDescription>
              </Alert>
            )}

            {keys.map((key) => (
              <Alert key={`${key.where}-${key.value}`} variant="warning" className="rounded-xl">
                <Warning />
                <AlertDescription className="flex flex-wrap items-center gap-2">
                  <span className="flex-1">
                    <span className="font-mono">{key.where}</span> looks like a real key. Keys belong in your encrypted values, not the spec.
                  </span>
                  <Button type="button" size="sm" variant="outline" onClick={() => sealKey(key.value)}>Move it to a value</Button>
                </AlertDescription>
              </Alert>
            ))}

            {check?.ok && check.secrets.length > 0 && (
              <div className="space-y-3">
                <p className="font-medium text-sm">Your values</p>
                {check.secrets.map((name) => (
                  <Field key={name}>
                    <FieldLabel className="font-mono">{`<${name}>`}</FieldLabel>
                    <Input
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      value={values[name] ?? ""}
                      onChange={(event) => setValues((old) => ({ ...old, [name]: event.target.value }))}
                      placeholder={reconnectId ? "Leave empty to keep the saved value" : undefined}
                    />
                  </Field>
                ))}
              </div>
            )}

            {spec && (
              <details className="rounded-xl border p-3">
                <summary className="cursor-pointer font-medium text-sm">The request for a sample email</summary>
                <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all font-mono text-muted-foreground text-xs">{preview}</pre>
              </details>
            )}

            {spec && (
              <div className="space-y-2 rounded-xl border p-3">
                <p className="font-medium text-sm">Send a test</p>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input type="email" value={from} onChange={(event) => setFrom(event.target.value)} placeholder="you@yourdomain.com" aria-label="Send from" />
                  <Button type="button" variant="outline" loading={testing} disabled={!from.includes("@")} onClick={sendTest}>Send to me</Button>
                </div>
                <p className="text-muted-foreground text-xs">From an address your provider lets you send from. It goes to your own address. Connecting needs a test that worked.</p>
                {test && (
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <Badge variant={test.result.ok ? "success" : "error"}>{test.result.status || "No answer"}</Badge>
                      {test.result.ok ? "The provider took it. Check your inbox." : test.result.error}
                      {test.result.idFound === false && <span className="text-warning-foreground text-xs">The message id wasn&apos;t where the spec says.</span>}
                      {test.key !== current && <span className="text-muted-foreground text-xs">The spec changed since. Test again.</span>}
                    </div>
                    {test.result.body && (
                      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-2 font-mono text-xs">{test.result.body}</pre>
                    )}
                  </div>
                )}
              </div>
            )}

            <p className="text-muted-foreground text-xs">
              Mail for your domains is received by HelloBox. Sent mail shows as Sent, never Delivered, until delivery events are set up.
            </p>
          </DialogPanel>
          <DialogFooter>
            <Button type="submit" loading={busy} disabled={!spec || !tested}><Key /> Connect</Button>
          </DialogFooter>
        </Form>
      </DialogPopup>
    </Dialog>
  );
}
