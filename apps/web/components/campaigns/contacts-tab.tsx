"use client";

import { type ColumnRole, guessColumnRole, parseCsv, splitFullName } from "@hellobox/mail/csv";
import { isFieldKey, toFieldKey } from "@hellobox/mail/template";
import {
  AddressBook, DotsThree, FileCsv, MagnifyingGlass, PencilSimple, Plus, Prohibit, Trash, UploadSimple, Warning, X,
} from "@phosphor-icons/react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Meter, MeterIndicator, MeterTrack } from "@/components/ui/meter";
import { Progress, ProgressIndicator, ProgressTrack } from "@/components/ui/progress";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { call } from "@/core/client/api";
import { notify, notifyError } from "@/core/client/notify";

export type ContactPage = Awaited<ReturnType<typeof call<"/contacts/list">>>;
type ContactRow = ContactPage["contacts"][number];

const IMPORT_CHUNK = 2_000;
const MAX_IMPORT_ROWS = 200_000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const fullName = (contact: { firstName: string | null; lastName: string | null }) =>
  [contact.firstName, contact.lastName].filter(Boolean).join(" ");

const formatCount = (value: number) => value.toLocaleString("en-US");

function useDebounced<T>(value: T, ms: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export function ContactsTab({ onChanged }: { onChanged: () => void }) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [data, setData] = useState<ContactPage | null>(null);
  const [editing, setEditing] = useState<ContactRow | "new" | null>(null);
  const [importing, setImporting] = useState(false);
  const [toDelete, setToDelete] = useState<ContactRow | null>(null);
  const [toUnsubscribe, setToUnsubscribe] = useState<ContactRow | null>(null);
  const search = useDebounced(query, 250);

  const refresh = useCallback(() => {
    call("/contacts/list", { query: search, page }).then(setData).catch(notifyError);
  }, [search, page]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  // The page's own counts and preview contacts update along with this list.
  const load = useCallback(() => {
    refresh();
    onChanged();
  }, [refresh, onChanged]);

  const pages = data ? Math.max(1, Math.ceil(data.matching / data.pageSize)) : 1;

  return (
    <div className="space-y-4">
      {data && <ContactsSummary data={data} />}

      <div className="flex flex-wrap items-center gap-2">
        <InputGroup className="min-w-48 flex-1">
          <InputGroupAddon><MagnifyingGlass /></InputGroupAddon>
          <InputGroupInput
            aria-label="Search contacts"
            placeholder="Search by name or email"
            value={query}
            onChange={(event) => { setQuery(event.target.value); setPage(0); }}
          />
        </InputGroup>
        <Button variant="outline" onClick={() => setImporting(true)}><UploadSimple /> Import CSV</Button>
        <Button onClick={() => setEditing("new")}><Plus /> Add contact</Button>
      </div>

      {!data ? (
        <div className="space-y-2">{[0, 1, 2, 3].map((row) => <Skeleton key={row} className="h-11 w-full rounded-lg" />)}</div>
      ) : data.total === 0 ? (
        <Empty className="rounded-2xl border bg-card">
          <EmptyHeader>
            <EmptyMedia variant="icon"><AddressBook /></EmptyMedia>
            <EmptyTitle>No contacts yet</EmptyTitle>
            <EmptyDescription>Import a CSV with an email column, or add people one at a time. Names and any other columns come along as fields for your templates.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent className="flex-row justify-center">
            <Button variant="outline" onClick={() => setImporting(true)}><UploadSimple /> Import CSV</Button>
            <Button onClick={() => setEditing("new")}><Plus /> Add contact</Button>
          </EmptyContent>
        </Empty>
      ) : data.contacts.length === 0 ? (
        <p className="rounded-2xl border bg-card p-6 text-center text-muted-foreground text-sm">No contacts match “{query}”.</p>
      ) : (
        <div className="overflow-hidden rounded-2xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead className="max-sm:hidden">Name</TableHead>
                <TableHead className="max-md:hidden">Fields</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-10"><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.contacts.map((contact) => {
                const fields = Object.entries(contact.fields);
                return (
                  <TableRow key={contact.id}>
                    <TableCell className="max-w-56 truncate font-medium text-foreground">{contact.email}</TableCell>
                    <TableCell className="max-w-40 truncate max-sm:hidden">{fullName(contact) || <span className="text-muted-foreground">—</span>}</TableCell>
                    <TableCell className="max-w-56 truncate text-muted-foreground max-md:hidden">
                      {fields.length ? fields.map(([key, value]) => `${key}: ${value}`).join(", ") : "—"}
                    </TableCell>
                    <TableCell>
                      <span className="flex items-center gap-1.5">
                        {contact.unsubscribedAt
                          ? <Badge variant="secondary">Unsubscribed</Badge>
                          : <Badge variant="success">Subscribed</Badge>}
                        {contact.syncError && (
                          <Tooltip>
                            <TooltipTrigger render={<span className="text-warning" aria-label="Resend rejected this contact" />}><Warning /></TooltipTrigger>
                            <TooltipPopup>Resend rejected this contact: {contact.syncError}</TooltipPopup>
                          </Tooltip>
                        )}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Menu>
                        <MenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label={`Actions for ${contact.email}`} />}><DotsThree /></MenuTrigger>
                        <MenuPopup align="end">
                          <MenuItem onClick={() => setEditing(contact)}><PencilSimple /> Edit</MenuItem>
                          {!contact.unsubscribedAt && <MenuItem onClick={() => setToUnsubscribe(contact)}><Prohibit /> Unsubscribe</MenuItem>}
                          <MenuSeparator />
                          <MenuItem variant="destructive" onClick={() => setToDelete(contact)}><Trash /> Delete</MenuItem>
                        </MenuPopup>
                      </Menu>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {pages > 1 && (
            <div className="flex items-center justify-between gap-2 border-t px-4 py-2 text-muted-foreground text-sm">
              <span className="tabular-nums">Page {page + 1} of {formatCount(pages)}</span>
              <span className="flex gap-1">
                <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button>
                <Button size="sm" variant="ghost" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Next</Button>
              </span>
            </div>
          )}
        </div>
      )}

      <ContactDialog
        contact={editing}
        fieldKeys={data?.fieldKeys ?? []}
        onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); load(); }}
      />
      <ImportDialog open={importing} onOpenChange={setImporting} onImported={load} />

      <AlertDialog open={toDelete !== null} onOpenChange={(open) => { if (!open) setToDelete(null); }}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {toDelete?.email}?</AlertDialogTitle>
            <AlertDialogDescription>They come off your contacts, and off this workspace&apos;s Resend segment if you use Resend. Campaigns already sent aren&apos;t affected.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Keep contact</AlertDialogClose>
            <AlertDialogClose
              render={<Button variant="destructive" />}
              onClick={async () => {
                if (!toDelete) return;
                try {
                  await call("/contacts/delete", { ids: [toDelete.id] });
                  load();
                } catch (error) {
                  notifyError(error);
                }
              }}
            >
              Delete contact
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      <AlertDialog open={toUnsubscribe !== null} onOpenChange={(open) => { if (!open) setToUnsubscribe(null); }}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Unsubscribe {toUnsubscribe?.email}?</AlertDialogTitle>
            <AlertDialogDescription>They won&apos;t get any more campaigns from this workspace. Only they can subscribe again.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
            <AlertDialogClose
              render={<Button variant="destructive" />}
              onClick={async () => {
                if (!toUnsubscribe) return;
                try {
                  await call("/contacts/unsubscribe", { id: toUnsubscribe.id });
                  load();
                } catch (error) {
                  notifyError(error);
                }
              }}
            >
              Unsubscribe
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

function ContactsSummary({ data }: { data: ContactPage }) {
  return (
    <div className="flex flex-wrap items-end gap-x-8 gap-y-3 rounded-2xl border bg-card p-4">
      <div className="min-w-56 flex-1 space-y-2">
        <p className="text-muted-foreground text-sm">
          <span className="font-semibold text-foreground tabular-nums">{formatCount(data.total)}</span>
          {data.limit !== null ? <> of <span className="tabular-nums">{formatCount(data.limit)}</span> contacts on your plan</> : " contacts"}
        </p>
        {data.limit !== null && (
          <Meter value={Math.min(data.total, data.limit)} max={data.limit} aria-label="Contacts used">
            <MeterTrack><MeterIndicator /></MeterTrack>
          </Meter>
        )}
      </div>
      <p className="text-muted-foreground text-sm"><span className="font-semibold text-foreground tabular-nums">{formatCount(data.unsubscribed)}</span> unsubscribed</p>
      {data.pending > 0 && (
        <p className="text-muted-foreground text-sm"><span className="font-semibold text-foreground tabular-nums">{formatCount(data.pending)}</span> waiting to reach Resend</p>
      )}
    </div>
  );
}

type FieldRow = { id: number; key: string; value: string };

export function ContactDialog({
  contact, fieldKeys, initialEmail, onClose, onSaved,
}: {
  contact: ContactRow | "new" | null;
  fieldKeys: string[];
  // Prefills a new contact, as when saving a recipient from the composer.
  initialEmail?: string;
  onClose: () => void;
  onSaved: (email: string) => void;
}) {
  return (
    <Dialog open={contact !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogPopup className="sm:max-w-lg">
        {contact !== null && (
          <ContactForm
            key={contact === "new" ? "new" : contact.id}
            existing={contact === "new" ? null : contact}
            fieldKeys={fieldKeys}
            initialEmail={initialEmail}
            onSaved={onSaved}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}

function ContactForm({
  existing, fieldKeys, initialEmail, onSaved,
}: {
  existing: ContactRow | null;
  fieldKeys: string[];
  initialEmail?: string;
  onSaved: (email: string) => void;
}) {
  const nextId = useRef(0);
  const [rows, setRows] = useState<FieldRow[]>(() => {
    const entries = existing ? Object.entries(existing.fields) : fieldKeys.slice(0, 3).map((key) => [key, ""] as const);
    return entries.map(([key, value], index) => ({ id: index - entries.length, key, value }));
  });
  const [saving, setSaving] = useState(false);

  const badKey = rows.find((row) => row.key && !isFieldKey(row.key));

  return (
    <Form
      className="contents"
      onSubmit={async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (badKey) return;
        const form = new FormData(event.currentTarget);
        const fields = Object.fromEntries(rows.filter((row) => row.key.trim()).map((row) => [row.key.trim(), row.value]));
        setSaving(true);
        try {
          const email = existing?.email ?? String(form.get("email")).trim().toLowerCase();
          await call("/contacts/save", {
            id: existing?.id,
            email,
            firstName: String(form.get("firstName")),
            lastName: String(form.get("lastName")),
            fields,
          });
          notify(existing ? "Contact saved" : "Contact added");
          onSaved(email);
        } catch (error) {
          notifyError(error);
        } finally {
          setSaving(false);
        }
      }}
    >
      <DialogHeader>
        <DialogTitle>{existing ? "Edit contact" : "Add contact"}</DialogTitle>
        {existing && <DialogDescription>The email address is who they are in Resend too, so it can&apos;t change. Delete and add them again instead.</DialogDescription>}
      </DialogHeader>
      <DialogPanel className="space-y-4">
        <Field>
          <FieldLabel>Email</FieldLabel>
          <Input name="email" type="email" required autoFocus={!existing && !initialEmail} disabled={Boolean(existing)} defaultValue={existing?.email ?? initialEmail} placeholder="ada@example.com" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field><FieldLabel>First name</FieldLabel><Input name="firstName" maxLength={200} autoFocus={Boolean(initialEmail)} defaultValue={existing?.firstName ?? ""} /></Field>
          <Field><FieldLabel>Last name</FieldLabel><Input name="lastName" maxLength={200} defaultValue={existing?.lastName ?? ""} /></Field>
        </div>
        <div className="space-y-2">
          <p className="font-medium text-foreground text-sm">Custom fields</p>
          {rows.map((row) => (
            <div key={row.id} className="flex items-center gap-2">
              <Input
                aria-label="Field name"
                className="w-40 font-mono"
                placeholder="company"
                list="contact-field-keys"
                value={row.key}
                onChange={(event) => setRows(rows.map((item) => (item.id === row.id ? { ...item, key: event.target.value } : item)))}
              />
              <Input
                aria-label={`Value for ${row.key || "field"}`}
                className="flex-1"
                maxLength={1000}
                value={row.value}
                onChange={(event) => setRows(rows.map((item) => (item.id === row.id ? { ...item, value: event.target.value } : item)))}
              />
              <Button size="icon-sm" variant="ghost" aria-label="Remove field" onClick={() => setRows(rows.filter((item) => item.id !== row.id))}><X /></Button>
            </div>
          ))}
          <datalist id="contact-field-keys">{fieldKeys.map((key) => <option key={key} value={key} />)}</datalist>
          {badKey && <p className="text-destructive text-xs">Field names use lowercase letters, numbers and underscores, and start with a letter. email, first_name and last_name are taken.</p>}
          <Button size="sm" variant="outline" onClick={() => setRows([...rows, { id: nextId.current++, key: "", value: "" }])}><Plus /> Add field</Button>
          {/* Not a FieldDescription: there's no single Field here, and Base UI throws without one. */}
          <p className="text-muted-foreground text-xs">Use them in templates as <code className="font-mono">{"{{ contact.company }}"}</code>.</p>
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button type="submit" disabled={saving || Boolean(badKey)}>{existing ? "Save contact" : "Add contact"}</Button>
      </DialogFooter>
    </Form>
  );
}

type Column = { header: string; role: ColumnRole; key: string };

const ROLE_LABELS: { value: ColumnRole; label: string }[] = [
  { value: "email", label: "Email" },
  { value: "first_name", label: "First name" },
  { value: "last_name", label: "Last name" },
  { value: "full_name", label: "Full name" },
  { value: "field", label: "Custom field" },
  { value: "skip", label: "Skip" },
];

function buildContacts(rows: string[][], columns: Column[]) {
  const contacts: { email: string; firstName: string | null; lastName: string | null; fields: Record<string, string> }[] = [];
  let invalid = 0;
  for (const row of rows) {
    let email = "";
    let firstName = "";
    let lastName = "";
    const fields: Record<string, string> = {};
    columns.forEach((column, index) => {
      const value = (row[index] ?? "").trim();
      if (column.role === "email") email = value.toLowerCase();
      else if (column.role === "first_name") firstName = value;
      else if (column.role === "last_name") lastName = value;
      else if (column.role === "full_name") {
        const split = splitFullName(value);
        firstName ||= split.first;
        lastName ||= split.last;
      } else if (column.role === "field" && value) fields[column.key] = value.slice(0, 1000);
    });
    if (!EMAIL.test(email)) {
      invalid++;
      continue;
    }
    contacts.push({ email, firstName: firstName.slice(0, 200) || null, lastName: lastName.slice(0, 200) || null, fields });
  }
  return { contacts, invalid };
}

function ImportDialog({ open, onOpenChange, onImported }: { open: boolean; onOpenChange: (open: boolean) => void; onImported: () => void }) {
  const [file, setFile] = useState<{ name: string; rows: string[][] } | null>(null);
  const [columns, setColumns] = useState<Column[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const reset = () => {
    setFile(null);
    setColumns([]);
    setProgress(null);
  };

  const readFile = async (picked: File) => {
    const rows = parseCsv(await picked.text());
    const [header, ...body] = rows;
    if (!header || !body.length) {
      notifyError(new Error("That file has no rows under its header"));
      return;
    }
    if (body.length > MAX_IMPORT_ROWS) {
      notifyError(new Error(`Import up to ${formatCount(MAX_IMPORT_ROWS)} rows at a time`));
      return;
    }
    setFile({ name: picked.name, rows: body });
    setColumns(header.map((cell) => {
      const role = guessColumnRole(cell);
      const key = toFieldKey(cell);
      return { header: cell, role: role === "field" && !isFieldKey(key) ? "skip" : role, key };
    }));
  };

  const emailColumns = columns.filter((column) => column.role === "email").length;
  const badKeys = columns.filter((column) => column.role === "field" && !isFieldKey(column.key));
  const duplicateKeys = columns
    .filter((column) => column.role === "field")
    .some((column, index, list) => list.findIndex((other) => other.key === column.key) !== index);
  const ready = file && emailColumns === 1 && !badKeys.length && !duplicateKeys;
  const busy = progress !== null;

  const runImport = async () => {
    if (!file || !ready) return;
    const { contacts, invalid } = buildContacts(file.rows, columns);
    if (!contacts.length) {
      notifyError(new Error("None of the rows has a valid email address"));
      return;
    }
    setProgress({ done: 0, total: contacts.length });
    let added = 0;
    let updated = 0;
    try {
      for (let start = 0; start < contacts.length; start += IMPORT_CHUNK) {
        const result = await call("/contacts/import", { contacts: contacts.slice(start, start + IMPORT_CHUNK) });
        added += result.added;
        updated += result.updated;
        setProgress({ done: Math.min(start + IMPORT_CHUNK, contacts.length), total: contacts.length });
      }
      const skipped = invalid ? `, ${formatCount(invalid)} skipped without a valid email` : "";
      notify("Import finished", `${formatCount(added)} added, ${formatCount(updated)} updated${skipped}.`);
      onOpenChange(false);
      reset();
    } catch (error) {
      if (added || updated) notify("Import stopped partway", `${formatCount(added)} added and ${formatCount(updated)} updated before it stopped.`);
      notifyError(error);
      setProgress(null);
    } finally {
      onImported();
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (busy) return; onOpenChange(next); if (!next) reset(); }}>
      <DialogPopup className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import contacts</DialogTitle>
          <DialogDescription>
            A CSV with a header row and one email column. Existing contacts are updated, and anyone who unsubscribed stays unsubscribed.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          {!file ? (
            <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed p-8 text-center hover:bg-muted/40 has-focus-visible:ring-2 has-focus-visible:ring-ring">
              <FileCsv className="size-8 text-muted-foreground" />
              <span className="font-medium text-foreground text-sm">Choose a CSV file</span>
              <span className="text-muted-foreground text-xs">Comma, semicolon or tab separated</span>
              <input
                type="file"
                accept=".csv,text/csv,text/plain"
                className="sr-only"
                onChange={(event) => {
                  const picked = event.target.files?.[0];
                  if (picked) readFile(picked).catch(notifyError);
                  event.target.value = "";
                }}
              />
            </label>
          ) : (
            <>
              <p className="text-sm">
                <span className="font-medium text-foreground">{file.name}</span>
                <span className="text-muted-foreground"> · {formatCount(file.rows.length)} rows</span>
              </p>
              <div className="overflow-hidden rounded-xl border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Column</TableHead>
                      <TableHead className="max-sm:hidden">First row</TableHead>
                      <TableHead>Import as</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {columns.map((column, index) => (
                      <TableRow key={`${column.header}-${index}`}>
                        <TableCell className="max-w-36 truncate font-medium text-foreground">{column.header || `Column ${index + 1}`}</TableCell>
                        <TableCell className="max-w-40 truncate text-muted-foreground max-sm:hidden">{file.rows[0]?.[index] ?? ""}</TableCell>
                        <TableCell>
                          <div className="flex flex-wrap items-center gap-2">
                            <Select
                              value={column.role}
                              onValueChange={(value) => {
                                if (value) setColumns(columns.map((item, i) => (i === index ? { ...item, role: value as ColumnRole } : item)));
                              }}
                              items={ROLE_LABELS}
                            >
                              <SelectTrigger size="sm" className="w-36" aria-label={`Import ${column.header} as`}><SelectValue /></SelectTrigger>
                              <SelectPopup>{ROLE_LABELS.map((role) => <SelectItem key={role.value} value={role.value}>{role.label}</SelectItem>)}</SelectPopup>
                            </Select>
                            {column.role === "field" && (
                              <Input
                                size="sm"
                                className="w-36 font-mono"
                                aria-label={`Field name for ${column.header}`}
                                aria-invalid={!isFieldKey(column.key)}
                                value={column.key}
                                onChange={(event) => setColumns(columns.map((item, i) => (i === index ? { ...item, key: event.target.value } : item)))}
                              />
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {emailColumns !== 1 && <p className="text-destructive text-sm">Pick exactly one email column.</p>}
              {badKeys.length > 0 && <p className="text-destructive text-sm">Field names use lowercase letters, numbers and underscores, and start with a letter.</p>}
              {duplicateKeys && <p className="text-destructive text-sm">Two columns use the same field name.</p>}
              {progress && (
                <Progress value={progress.done} max={progress.total} aria-label="Import progress">
                  <ProgressTrack><ProgressIndicator /></ProgressTrack>
                </Progress>
              )}
            </>
          )}
        </DialogPanel>
        <DialogFooter>
          {file && <Button variant="ghost" disabled={busy} onClick={reset}>Choose another file</Button>}
          <Button disabled={!ready || busy} onClick={runImport}>
            {busy ? `Importing ${formatCount(progress.done)} of ${formatCount(progress.total)}` : "Import contacts"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
