"use client";

import { CheckCircle, FileArrowUp, TrayArrowDown, WarningCircle, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Callout } from "@/components/callout";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { type Bootstrap, call } from "@/core/client/api";
import { cancelUpload, clearFinishedUploads, type ImportTarget, startImports, useImportUploads } from "@/core/client/imports";
import { notifyError } from "@/core/client/notify";
import { formatBytes } from "./types";

type ImportRow = Awaited<ReturnType<typeof call<"/imports/list">>>["imports"][number];

const NEW_ADDRESS = "__new__";

const HOW_TO = [
  {
    value: "gmail",
    label: "Gmail",
    steps: [
      <>Go to <a className="underline" href="https://takeout.google.com" target="_blank" rel="noreferrer">takeout.google.com</a> and click <strong>Deselect all</strong>.</>,
      <>Tick <strong>Mail</strong> only, then <strong>Next step</strong> and <strong>Create export</strong>.</>,
      <>Google emails you a link, usually within hours. Download and unzip it: the mail is the <strong>.mbox</strong> file inside.</>,
    ],
  },
  {
    value: "apple",
    label: "Apple Mail",
    steps: [
      <>Select a mailbox in the sidebar, then <strong>Mailbox → Export Mailbox…</strong></>,
      <>Choose a folder. Upload the file named <strong>mbox</strong> inside the folder it makes.</>,
    ],
  },
  {
    value: "thunderbird",
    label: "Thunderbird",
    steps: [
      <>Install the <strong>ImportExportTools NG</strong> add-on.</>,
      <>Right-click a folder, <strong>Export folder</strong>, and pick <strong>MBOX</strong>.</>,
    ],
  },
  {
    value: "other",
    label: "Other",
    steps: [
      <>Export as <strong>MBOX</strong> if you can, or save emails as <strong>.eml</strong> files (most apps let you drag them out).</>,
      <>Outlook: drag emails to a folder to get .eml files. PST files aren&apos;t supported.</>,
    ],
  },
];

function useImports(active: boolean) {
  const [rows, setRows] = useState<ImportRow[]>([]);
  const load = useCallback(() => call("/imports/list").then((result) => setRows(result.imports)).catch(() => undefined), []);
  const running = rows.some((row) => row.status === "queued" || row.status === "running");
  useEffect(() => {
    load();
    if (!active && !running) return;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [load, active, running]);
  return { rows, load };
}

function ServerImport({ row, onChanged }: { row: ImportRow; onChanged: () => void }) {
  const working = row.status === "queued" || row.status === "running";
  const percent = row.size ? Math.min(100, Math.round((row.bytesRead / row.size) * 100)) : 0;
  const counts = [
    `${row.imported.toLocaleString()} imported`,
    row.skipped ? `${row.skipped.toLocaleString()} already here or skipped` : null,
    row.failed ? `${row.failed.toLocaleString()} couldn't be read` : null,
  ].filter(Boolean).join(" · ");
  return (
    <li className="space-y-1.5 py-3">
      <div className="flex items-center gap-2 text-sm">
        {row.status === "done" ? <CheckCircle className="text-success shrink-0" /> : row.status === "failed" ? <WarningCircle className="text-destructive-foreground shrink-0" /> : <TrayArrowDown className="text-muted-foreground shrink-0" />}
        <span className="min-w-0 flex-1 truncate font-medium">{row.filename}</span>
        <span className="shrink-0 text-muted-foreground text-xs">into {row.mailbox}</span>
        {working && (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Stop import"
            onClick={async () => {
              try {
                await call("/imports/cancel", { id: row.id });
                onChanged();
              } catch (error) {
                notifyError(error);
              }
            }}
          >
            <X />
          </Button>
        )}
      </div>
      {working && <Progress value={row.status === "queued" ? null : percent} aria-label={`Importing ${row.filename}`} />}
      <p className="text-muted-foreground text-xs">
        {row.status === "queued" ? "Waiting to start…" : row.status === "running" ? `${percent}% · ${counts}` : counts}
        {row.error && <span className="block text-destructive-foreground">{row.error}</span>}
      </p>
    </li>
  );
}

// Choose where the mail goes, pick files, and watch them upload and import.
export function ImportPanel({ data, onboarding = false }: { data: Bootstrap; onboarding?: boolean }) {
  const uploads = useImportUploads();
  const uploading = uploads.some((upload) => upload.status === "uploading");
  const { rows, load } = useImports(uploading);
  const mailboxes = data.mailboxes;
  const [target, setTarget] = useState(mailboxes[0]?.id ?? NEW_ADDRESS);
  const [address, setAddress] = useState(mailboxes.length ? "" : data.user.email);
  const [files, setFiles] = useState<File[]>([]);
  const input = useRef<HTMLInputElement>(null);

  // Refreshes the list as each upload hands over to the server.
  const finished = uploads.filter((upload) => upload.status !== "uploading").length;
  useEffect(() => {
    load();
  }, [finished, load]);

  async function start() {
    const chosen: ImportTarget = target === NEW_ADDRESS ? { address: address.trim() } : { mailboxId: target };
    if ("address" in chosen && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(chosen.address)) {
      notifyError(new Error("Enter the address this mail was sent to"));
      return;
    }
    const picked = files;
    setFiles([]);
    if (input.current) input.current.value = "";
    await startImports(picked, chosen);
  }

  const serverRows = rows.filter((row) => row.status !== "uploading");
  return (
    <div className="space-y-4">
      <Tabs defaultValue="gmail">
        <TabsList className="w-full">
          {HOW_TO.map((item) => <TabsTab key={item.value} value={item.value}>{item.label}</TabsTab>)}
        </TabsList>
        {HOW_TO.map((item) => (
          <TabsPanel key={item.value} value={item.value}>
            <ol className="mt-3 list-decimal space-y-1 ps-5 text-muted-foreground text-sm">
              {item.steps.map((step, index) => <li key={index}>{step}</li>)}
            </ol>
          </TabsPanel>
        ))}
      </Tabs>

      <Field>
        <FieldLabel>Import into</FieldLabel>
        <Select
          value={target}
          onValueChange={(value) => setTarget(String(value))}
          items={[...mailboxes.map((mailbox) => ({ label: mailbox.address, value: mailbox.id })), { label: "A new mailbox for another address…", value: NEW_ADDRESS }]}
        >
          <SelectTrigger aria-label="Import into"><SelectValue /></SelectTrigger>
          <SelectPopup>
            {mailboxes.map((mailbox) => <SelectItem key={mailbox.id} value={mailbox.id}>{mailbox.address}</SelectItem>)}
            <SelectItem value={NEW_ADDRESS}>A new mailbox for another address…</SelectItem>
          </SelectPopup>
        </Select>
        {target === NEW_ADDRESS && (
          <>
            <Input className="mt-2" type="email" placeholder="you@gmail.com" value={address} onChange={(event) => setAddress(event.target.value)} aria-label="Address the mail was sent to" />
            <FieldDescription>
              The address this mail was sent to. It gets its own mailbox that only you read. It can&apos;t send until its domain is in HelloBox, so a Gmail address keeps your old mail as an archive.
            </FieldDescription>
          </>
        )}
      </Field>

      <Field>
        <FieldLabel>Files</FieldLabel>
        <input
          ref={input}
          type="file"
          multiple
          className="sr-only"
          onChange={(event) => setFiles([...(event.target.files ?? [])].filter((file) => file.size > 0))}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => input.current?.click()}><FileArrowUp /> Choose .mbox or .eml files</Button>
          {files.length > 0 && (
            <span className="text-muted-foreground text-sm">
              {files.length === 1 ? files[0]!.name : `${files.length} files`} · {formatBytes(files.reduce((sum, file) => sum + file.size, 0))}
            </span>
          )}
        </div>
        <FieldDescription>Emails already here are skipped, so importing the same file twice is safe.</FieldDescription>
      </Field>

      <Button disabled={files.length === 0} onClick={start}><TrayArrowDown /> Import</Button>

      {uploading && (
        <Callout tone="warning" icon={<WarningCircle />}>
          Keep this page open until the upload finishes.{onboarding ? " You can carry on with setup meanwhile." : " You can close this window."} The importing itself carries on without you.
        </Callout>
      )}

      {(uploads.length > 0 || serverRows.length > 0) && (
        <ul className="divide-y border-t">
          {uploads.filter((upload) => upload.status !== "done").map((upload) => (
            <li key={upload.key} className="space-y-1.5 py-3">
              <div className="flex items-center gap-2 text-sm">
                <FileArrowUp className="shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-medium">{upload.filename}</span>
                <Button size="icon-xs" variant="ghost" aria-label="Cancel upload" onClick={() => cancelUpload(upload.key)}><X /></Button>
              </div>
              {upload.status === "uploading" ? (
                <>
                  <Progress value={Math.round((upload.sent / upload.size) * 100)} aria-label={`Uploading ${upload.filename}`} />
                  <p className="text-muted-foreground text-xs">Uploading · {formatBytes(upload.sent)} of {formatBytes(upload.size)}</p>
                </>
              ) : (
                <p className="text-destructive-foreground text-xs">{upload.error}</p>
              )}
            </li>
          ))}
          {serverRows.map((row) => <ServerImport key={row.id} row={row} onChanged={load} />)}
        </ul>
      )}
      {uploads.some((upload) => upload.status === "failed") && (
        <Button size="xs" variant="ghost" onClick={clearFinishedUploads}>Clear failed uploads</Button>
      )}
    </div>
  );
}

// Opened from the account menu and the connect prompt.
let open = false;
const listeners = new Set<() => void>();
export function openImportDialog() {
  open = true;
  for (const listener of listeners) listener();
}
function closeImportDialog() {
  open = false;
  for (const listener of listeners) listener();
}

export function ImportDialog({ data, onChanged }: { data: Bootstrap; onChanged: () => void }) {
  const isOpen = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => open,
    () => false,
  );
  return (
    <Dialog open={isOpen} onOpenChange={(next) => { if (!next) { closeImportDialog(); onChanged(); } }}>
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Import mail</DialogTitle>
          <DialogDescription>
            Bring your old mail over from Gmail, Apple Mail, Thunderbird or any app that exports MBOX or EML. Folders, labels, stars and read state come with it where the export has them.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <ImportPanel data={data} />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
