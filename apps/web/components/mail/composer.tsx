"use client";

import {
  CalendarDots, CaretUp, Minus, Paperclip, PaperPlaneTilt, Plus, TextB, TextItalic, ListBullets, Warning, X, CodeBlock,
  MarkdownLogo,
} from "@phosphor-icons/react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { TemplateInsertDialog } from "@/components/campaigns/template-insert-dialog";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Group, GroupSeparator } from "@/components/ui/group";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Progress } from "@/components/ui/progress";
import { Select, SelectItem, SelectPopup, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { type Bootstrap, call } from "@/core/client/api";
import { errorAction, errorMessage, notify, notifyError } from "@/core/client/notify";
import { cn } from "@/lib/utils";
import { applyBlockMarkdown, applyInlineMarkdown, linkifyBeforeCaret, outgoingHtml, pasteLink } from "./composer-editor";
import { IconAction } from "./icon-action";
import { RecipientField } from "./recipient-field";
import { ScheduleDialog } from "./schedule-dialog";
import { fileIcon } from "./file-icon";
import { type ComposeState, formatBytes } from "./types";

const ACTIVE_FORMAT = "bg-brand-soft text-brand-foreground hover:bg-brand-soft";
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
// The From list's last option, which opens the form for a new mailbox.
const NEW_MAILBOX = "new-mailbox";

interface FileItem {
  key: string;
  id?: string;
  name: string;
  type?: string;
  size: number;
  progress: number;
  error?: string;
}

async function uploadFile(file: File, onProgress: (progress: number) => void) {
  const { id, partSize, urls } = await call("/uploads/start", {
    filename: file.name,
    contentType: file.type || "application/octet-stream",
    size: file.size,
  });
  const parts: { partNumber: number; etag: string }[] = [];
  try {
    // Files go straight to storage in parts, so no file ever sits in server memory.
    for (const [index, url] of urls.entries()) {
      const res = await fetch(url, {
        method: "PUT",
        body: file.slice(index * partSize, (index + 1) * partSize),
      });
      const etag = res.headers.get("etag");
      if (!res.ok || !etag) throw new Error("The upload didn't finish");
      parts.push({ partNumber: index + 1, etag });
      onProgress((index + 1) / urls.length);
    }
    await call("/uploads/complete", { id, parts });
    return id;
  } catch (error) {
    await call("/uploads/abort", { id }).catch(() => undefined);
    throw error;
  }
}

const SCHEDULES = [
  { label: "In 1 hour", at: () => new Date(Date.now() + 3_600_000) },
  {
    label: "Tomorrow morning",
    at: () => {
      const date = new Date(Date.now() + 86_400_000);
      date.setHours(9, 0, 0, 0);
      return date;
    },
  },
  {
    label: "Next Monday morning",
    at: () => {
      const date = new Date();
      date.setDate(date.getDate() + ((8 - date.getDay()) % 7 || 7));
      date.setHours(9, 0, 0, 0);
      return date;
    },
  },
];

export function Composer({
  initial, data, onClose, onSent, onMailboxCreated,
}: {
  initial: ComposeState;
  data: Bootstrap;
  onClose: () => void;
  onSent: (restore?: Omit<ComposeState, "key">) => void;
  onMailboxCreated: () => void;
}) {
  const usable = data.mailboxes.filter((mailbox) => data.domains.find((d) => d.id === mailbox.domainId)?.enabled);
  const admin = data.role !== "member";
  const [addingMailbox, setAddingMailbox] = useState(false);
  const [mailboxId, setMailboxId] = useState(initial.mailboxId ?? usable[0]?.id ?? "");
  const [to, setToState] = useState(initial.to ?? []);
  const [cc, setCcState] = useState(initial.cc ?? []);
  const [bcc, setBccState] = useState(initial.bcc ?? []);
  const [showCc, setShowCc] = useState(Boolean(initial.cc?.length || initial.bcc?.length));
  const [subject, setSubject] = useState(initial.subject ?? "");
  const [files, setFiles] = useState<FileItem[]>(
    (initial.uploadIds ?? []).map((id) => ({ key: id, id, name: "Attachment", size: 0, progress: 1 })),
  );
  const [minimized, setMinimized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [pickingTime, setPickingTime] = useState(false);
  // What was written when the template picker opened, or null while it's closed.
  const [templateBody, setTemplateBody] = useState<string | null>(null);
  const [formats, setFormats] = useState({ bold: false, italic: false, list: false });
  // Markdown typed in the body (**bold**, - lists, # headings…) formats itself while this is on.
  const [markdown, setMarkdown] = useState(true);
  const draftId = useRef(initial.draftId);
  const editor = useRef<HTMLDivElement>(null);
  const dirty = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const syncFormats = useCallback(() => {
    const node = document.getSelection()?.anchorNode;
    const inside = Boolean(node && editor.current?.contains(node));
    setFormats({
      bold: inside && document.queryCommandState("bold"),
      italic: inside && document.queryCommandState("italic"),
      list: inside && document.queryCommandState("insertUnorderedList"),
    });
  }, []);

  useEffect(() => {
    document.addEventListener("selectionchange", syncFormats);
    return () => document.removeEventListener("selectionchange", syncFormats);
  }, [syncFormats]);

  const markDirty = useCallback(() => {
    dirty.current = true;
    setSaved(null);
  }, []);
  // A sandboxed SES account only delivers to verified addresses, so the composer checks
  // recipients as they're added instead of letting Send fail.
  const [blocked, setBlocked] = useState<string[]>([]);
  // Addresses that bounced permanently or reported mail as spam. Sending to them takes a
  // deliberate tick, and the composer says why.
  const [suppressed, setSuppressed] = useState<{ email: string; why: string }[]>([]);
  const [sendAnyway, setSendAnyway] = useState(false);
  const recipientKey = [...to, ...cc, ...bcc].join(",");
  useEffect(() => {
    const recipients = recipientKey ? recipientKey.split(",") : [];
    const timer = setTimeout(() => {
      setSendAnyway(false);
      if (!mailboxId || !recipients.length) {
        setBlocked([]);
        setSuppressed([]);
        return;
      }
      call("/mail/check-recipients", { mailboxId, recipients })
        .then((result) => {
          setBlocked(result.blocked);
          setSuppressed(result.suppressed);
        })
        .catch(() => {
          setBlocked([]);
          setSuppressed([]);
        });
    }, 400);
    return () => clearTimeout(timer);
  }, [mailboxId, recipientKey]);

  const setTo = (values: string[]) => { setToState(values); markDirty(); };
  const setCc = (values: string[]) => { setCcState(values); markDirty(); };
  const setBcc = (values: string[]) => { setBccState(values); markDirty(); };

  useEffect(() => {
    const element = editor.current;
    if (!element || !initial.html) return;
    element.innerHTML = initial.html;
    // A reply already has its recipients, so writing starts straight away, in the empty
    // line above the quote rather than inside it.
    if (initial.to?.length && element.firstElementChild?.tagName === "P") {
      element.focus();
      const range = document.createRange();
      range.setStart(element.firstElementChild, 0);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  }, [initial.html, initial.to?.length]);

  // What the person wrote, or "" when the editor only holds empty lines.
  const writtenHtml = () => {
    const element = editor.current;
    if (!element) return "";
    return element.textContent?.replace(/\u200B/g, "").trim() || element.querySelector("img, hr, table") ? outgoingHtml(element) : "";
  };

  const payload = useCallback(
    () => ({
      mailboxId,
      threadId: initial.threadId,
      replyToMessageId: initial.replyToMessageId,
      to, cc, bcc, subject,
      html: outgoingHtml(editor.current),
      uploadIds: files.flatMap((file) => file.id ?? []),
    }),
    [mailboxId, initial.threadId, initial.replyToMessageId, to, cc, bcc, subject, files],
  );

  const saveDraft = useCallback(async () => {
    if (!mailboxId || !dirty.current) return;
    dirty.current = false;
    try {
      const body = payload();
      const valid = (list: string[]) => list.filter((address) => EMAIL.test(address));
      const { id } = await call("/drafts/save", { id: draftId.current, ...body, to: valid(body.to), cc: valid(body.cc), bcc: valid(body.bcc) });
      draftId.current = id;
      setSaved("Saved");
    } catch {
      dirty.current = true;
      setSaved("Couldn't save");
    }
  }, [mailboxId, payload]);

  useEffect(() => {
    const timer = setInterval(saveDraft, 5_000);
    return () => clearInterval(timer);
  }, [saveDraft]);

  const send = useCallback(async (sendAt?: Date) => {
    setBusy(true);
    try {
      const item = await call("/mail/send", {
        ...payload(),
        draftId: draftId.current,
        sendAt: sendAt?.toISOString(),
        allowSuppressed: sendAnyway || undefined,
      });
      onClose();
      onSent();
      if (sendAt) {
        notify("Scheduled", `Sends ${sendAt.toLocaleString()}`);
        return;
      }
      const toastId = toastManager.add({
        title: "Sending…",
        description: "You have 10 seconds to change your mind.",
        timeout: 10_000,
        type: "success",
        data: {
          secondaryAction: {
            label: "Send now",
            onClick: async () => {
              toastManager.close(toastId);
              try {
                await call("/mail/send-now", { id: item.id });
              } catch (error) {
                notifyError(error);
              }
            },
          },
        },
        actionProps: {
          children: "Undo",
          onClick: async () => {
            toastManager.close(toastId);
            try {
              onSent(await call("/mail/cancel", { id: item.id }));
            } catch (error) {
              notifyError(error);
            }
          },
        },
      });
    } catch (error) {
      notifyError(error);
      setBusy(false);
    }
  }, [payload, onClose, onSent, sendAnyway]);

  async function addFiles(list: FileList | null) {
    for (const file of Array.from(list ?? [])) {
      const key = crypto.randomUUID();
      setFiles((current) => [...current, { key, name: file.name, type: file.type, size: file.size, progress: 0 }]);
      const patch = (next: Partial<FileItem>) =>
        setFiles((current) => current.map((item) => (item.key === key ? { ...item, ...next } : item)));
      try {
        const id = await uploadFile(file, (progress) => patch({ progress }));
        patch({ id, progress: 1 });
        dirty.current = true;
      } catch (error) {
        patch({ error: errorMessage(error) });
        if (errorAction(error)) notifyError(error);
      }
    }
  }

  const uploading = files.some((file) => !file.id && !file.error);
  const canSend =
    !busy && !uploading && Boolean(mailboxId) && [...to, ...cc, ...bcc].length > 0 && blocked.length === 0 &&
    (suppressed.length === 0 || sendAnyway);
  const format = (command: string) => () => {
    document.execCommand(command);
    markDirty();
    syncFormats();
  };

  // Minimizing only hides the composer. The message body lives in the editor's DOM, not in
  // state, so unmounting it would throw away what was written (and its undo history).
  return (
    <>
    {minimized && (
      <div className="fixed right-4 bottom-0 z-40 flex w-72 items-center gap-1 rounded-t-xl border border-b-0 bg-popover p-1.5 shadow-lg">
        <Button variant="ghost" size="sm" className="min-w-0 flex-1 justify-start" onClick={() => setMinimized(false)}>
          <CaretUp /> <span className="truncate">{subject || "New message"}</span>
        </Button>
        <IconAction label="Save and close" onClick={() => { saveDraft(); onClose(); }}><X /></IconAction>
      </div>
    )}
    <section
      hidden={minimized}
      aria-label="New message"
      className="motion-rise fixed inset-x-2 bottom-0 z-40 flex max-h-[85dvh] flex-col overflow-hidden rounded-t-2xl border border-b-0 bg-popover shadow-[0_-8px_40px_-12px_rgb(30_30_70/0.28)] sm:inset-x-auto sm:right-4 sm:w-[580px]"
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && canSend) {
          event.preventDefault();
          send();
        }
      }}
    >
      <header className="flex shrink-0 items-center gap-1 border-b py-1.5 ps-4 pe-2">
        <h2 className="flex-1 font-semibold text-foreground text-sm">{initial.threadId ? "Reply" : "New message"}</h2>
        {saved && <span className="text-muted-foreground text-xs">{saved}</span>}
        <IconAction label="Minimize" onClick={() => setMinimized(true)}><Minus /></IconAction>
        <IconAction label="Save and close" onClick={() => { saveDraft(); onClose(); }}><X /></IconAction>
      </header>
      {/* One scroll area for everything between the header and the toolbar, so nothing gets
          cut off on a short screen or with the keyboard open. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
      <div className="divide-y px-4">
        <div className="flex min-h-10 items-center gap-1.5 py-1">
          <span className="w-10 shrink-0 text-muted-foreground text-sm">From</span>
          {admin && !initial.threadId && (addingMailbox || !usable.length) ? (
            <NewMailboxForm
              data={data}
              onCancel={usable.length ? () => setAddingMailbox(false) : undefined}
              onCreated={(id) => {
                setMailboxId(id);
                setAddingMailbox(false);
                markDirty();
                onMailboxCreated();
              }}
            />
          ) : !usable.length ? (
            <p className="py-1.5 text-muted-foreground text-sm">You don&apos;t have a mailbox to send from yet. Ask a workspace admin to give you one.</p>
          ) : (
            <Select
              value={mailboxId}
              onValueChange={(value) => {
                if (value === NEW_MAILBOX) setAddingMailbox(true);
                else if (value) { setMailboxId(value); markDirty(); }
              }}
              disabled={Boolean(initial.threadId)}
              items={usable.map((mailbox) => ({ label: mailbox.address, value: mailbox.id }))}
            >
              <SelectTrigger aria-label="From" size="sm" className="min-w-0 flex-1 border-transparent bg-transparent shadow-none before:hidden">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {usable.map((mailbox) => <SelectItem key={mailbox.id} value={mailbox.id}>{mailbox.address}</SelectItem>)}
                {admin && (
                  <>
                    <SelectSeparator />
                    <SelectItem value={NEW_MAILBOX}><span className="flex items-center gap-2"><Plus /> New mailbox…</span></SelectItem>
                  </>
                )}
              </SelectPopup>
            </Select>
          )}
        </div>
        <RecipientField
          label="To"
          values={to}
          onChange={setTo}
          autoFocus={!initial.to?.length}
          browse
          trailing={!showCc && <Button size="xs" variant="ghost" onClick={() => setShowCc(true)}>Cc Bcc</Button>}
        />
        {showCc && <RecipientField label="Cc" values={cc} onChange={setCc} />}
        {showCc && <RecipientField label="Bcc" values={bcc} onChange={setBcc} />}
        <input
          aria-label="Subject"
          placeholder="Subject"
          value={subject}
          onChange={(event) => { setSubject(event.target.value); markDirty(); }}
          className="h-10 w-full bg-transparent font-medium text-foreground text-sm outline-none placeholder:font-normal placeholder:text-muted-foreground"
        />
      </div>
      <div
        ref={editor}
        role="textbox"
        tabIndex={0}
        aria-multiline="true"
        aria-label="Message"
        contentEditable
        suppressContentEditableWarning
        data-placeholder="Write your message"
        onInput={(event) => {
          markDirty();
          const input = event.nativeEvent as InputEvent;
          const element = editor.current;
          if (!element || input.inputType !== "insertText" || !input.data) return;
          // Keyboards send one character, but autocomplete and dictation send whole words,
          // so the rules look at how the insertion ends.
          if (input.data.endsWith(" ") && markdown && applyBlockMarkdown(element)) return;
          if (/\s$/.test(input.data)) linkifyBeforeCaret(element, true);
          else if (markdown) applyInlineMarkdown(element);
        }}
        onKeyDown={(event) => {
          // The word before a new line becomes a link before the line breaks.
          if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && editor.current) linkifyBeforeCaret(editor.current, false);
        }}
        onPaste={(event) => {
          const element = editor.current;
          if (element && pasteLink(element, event.clipboardData.getData("text/plain"))) {
            event.preventDefault();
            markDirty();
          }
        }}
        className="min-h-32 flex-1 border-t px-4 py-3 sm:min-h-48 text-foreground text-sm leading-relaxed outline-none [&_a]:text-brand-foreground [&_a]:underline [&_a]:underline-offset-2 [&_blockquote]:border-s-2 [&_blockquote]:ps-3 [&_blockquote]:text-muted-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] [&_h1]:font-semibold [&_h1]:text-xl [&_h2]:font-semibold [&_h2]:text-lg [&_h3]:font-semibold [&_h3]:text-base [&_ol]:list-decimal [&_ol]:ps-5 [&_pre]:whitespace-pre-wrap [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:px-3 [&_pre]:py-2 [&_pre]:font-mono [&_pre]:text-[0.85em] [&_ul]:list-disc [&_ul]:ps-5"
      />
      {files.length > 0 && (
        <ul className="flex flex-wrap gap-1.5 border-t px-4 py-2">
          {files.map((file) => {
            const Icon = fileIcon(file.name, file.type);
            return (
            <li key={file.key} className="relative flex max-w-60 items-center gap-1.5 overflow-hidden rounded-lg border bg-card py-1 ps-2 pe-1 text-xs">
              <Icon className="shrink-0 text-muted-foreground" />
              <span className="truncate text-foreground">{file.name}</span>
              <span className={cn("shrink-0 text-muted-foreground", file.error && "text-destructive-foreground")}>
                {file.error ? "Failed" : file.size ? formatBytes(file.size) : ""}
              </span>
              <Button
                aria-label={`Remove ${file.name}`}
                size="icon-xs"
                variant="ghost"
                className="size-5"
                onClick={() => { setFiles((current) => current.filter((item) => item.key !== file.key)); markDirty(); }}
              >
                <X className="size-3!" />
              </Button>
              {file.progress < 1 && !file.error && <Progress value={file.progress * 100} className="absolute inset-x-0 bottom-0" />}
            </li>
            );
          })}
        </ul>
      )}
      {blocked.length > 0 && (
        <div className="flex items-start gap-2 border-t bg-warning/8 px-4 py-2.5 text-warning-foreground text-xs">
          <Warning className="mt-0.5 size-4 shrink-0" />
          <p>
            Your Amazon SES account is in the sandbox, so it can&apos;t send to {blocked.join(", ")} yet.{" "}
            <Link className="underline" href="/settings?tab=connection">Add them as test recipients</Link> or request production access.
          </p>
        </div>
      )}
      {suppressed.length > 0 && (
        <div className="flex items-start gap-2 border-t bg-warning/8 px-4 py-2.5 text-warning-foreground text-xs">
          <Warning className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0 space-y-1.5">
            <p>Your provider may refuse mail to {suppressed.length === 1 ? "this address" : "these addresses"}, and sending again can hurt your sender reputation.</p>
            <ul className="space-y-0.5 text-foreground">
              {suppressed.map((entry) => <li key={entry.email} className="break-words">{entry.why}</li>)}
            </ul>
            <label className="flex items-center gap-2 text-foreground">
              <Checkbox checked={sendAnyway} onCheckedChange={(checked) => setSendAnyway(checked === true)} />
              Send anyway
            </label>
          </div>
        </div>
      )}
      </div>
      <footer className="flex shrink-0 items-center gap-1 border-t p-2">
        <Group className="shrink-0">
          <Button disabled={!canSend} onClick={() => send()}>
            {busy ? <Spinner /> : <PaperPlaneTilt weight="fill" />} Send
            <Kbd className="ms-1 hidden bg-primary-foreground/15 text-primary-foreground sm:inline-flex">⌘↵</Kbd>
          </Button>
          <GroupSeparator />
          <Menu>
            <MenuTrigger disabled={!canSend} render={<Button aria-label="Schedule send" size="icon" />}><CalendarDots /></MenuTrigger>
            <MenuPopup align="start">
              <MenuGroup>
                <MenuGroupLabel>Send later</MenuGroupLabel>
                {SCHEDULES.map((item) => <MenuItem key={item.label} onClick={() => send(item.at())}>{item.label}</MenuItem>)}
              </MenuGroup>
              <MenuSeparator />
              <MenuItem onClick={() => setPickingTime(true)}><CalendarDots /> Pick date and time</MenuItem>
            </MenuPopup>
          </Menu>
        </Group>
        <Separator orientation="vertical" className="mx-1 h-5 shrink-0" />
        {/* Scrolls sideways when the formatting tools don't fit, instead of spilling off a
            narrow screen. */}
        <div
          role="toolbar"
          aria-label="Formatting"
          className="-my-1 flex min-w-0 flex-1 touch-pan-x items-center gap-1 overflow-x-auto overscroll-x-contain py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>*]:shrink-0"
        >
          <IconAction label="Bold" aria-pressed={formats.bold} className={cn(formats.bold && ACTIVE_FORMAT)} onMouseDown={(e) => e.preventDefault()} onClick={format("bold")}><TextB weight="bold" /></IconAction>
          <IconAction label="Italic" aria-pressed={formats.italic} className={cn(formats.italic && ACTIVE_FORMAT)} onMouseDown={(e) => e.preventDefault()} onClick={format("italic")}><TextItalic /></IconAction>
          <IconAction label="Bulleted list" aria-pressed={formats.list} className={cn(formats.list && ACTIVE_FORMAT)} onMouseDown={(e) => e.preventDefault()} onClick={format("insertUnorderedList")}><ListBullets /></IconAction>
          <IconAction
            label={markdown ? "Markdown formats as you type" : "Markdown is off for this message"}
            aria-pressed={markdown}
            className={cn(markdown && ACTIVE_FORMAT)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setMarkdown(!markdown)}
          >
            <MarkdownLogo />
          </IconAction>
          <IconAction label="Attach files" onClick={() => fileInput.current?.click()}><Paperclip /></IconAction>
          <IconAction label="Use a template" onClick={() => setTemplateBody(writtenHtml())}><CodeBlock /></IconAction>
        </div>
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
      </footer>
      <TemplateInsertDialog
        open={templateBody !== null}
        onOpenChange={(open) => { if (!open) setTemplateBody(null); }}
        recipient={to[0] ?? null}
        body={templateBody ?? ""}
        onInsert={(result) => {
          const element = editor.current;
          if (!element) return;
          const before = element.innerHTML;
          const subjectBefore = subject;
          element.innerHTML = result.html;
          if (!subject && result.subject) setSubject(result.subject);
          markDirty();
          // Setting the HTML clears the editor's own undo, so the toast brings back what was there.
          const toastId = toastManager.add({
            title: "Template inserted",
            type: "success",
            actionProps: {
              children: "Undo",
              onClick: () => {
                toastManager.close(toastId);
                element.innerHTML = before;
                setSubject(subjectBefore);
                markDirty();
              },
            },
          });
        }}
      />
      {pickingTime && (
        <ScheduleDialog
          onClose={() => setPickingTime(false)}
          onSchedule={(date) => {
            setPickingTime(false);
            send(date);
          }}
        />
      )}
    </section>
    </>
  );
}

// Lets an admin add an address without leaving the email. It's shared with the admins,
// like a mailbox added in settings.
function NewMailboxForm({ data, onCancel, onCreated }: {
  data: Bootstrap;
  onCancel?: () => void;
  onCreated: (id: string) => void;
}) {
  const domains = data.domains.filter((domain) => domain.enabled && !domain.removedAt);
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  if (!domains.length) {
    return (
      <p className="py-1.5 text-muted-foreground text-sm">
        <Link className="underline" href="/settings?tab=connection">Add a domain</Link> to create a mailbox to send from.
      </p>
    );
  }
  const create = async () => {
    const value = address.trim().toLowerCase();
    if (!EMAIL.test(value) || busy) return;
    setBusy(true);
    try {
      const mailbox = await call("/mailboxes/create", { address: value });
      notify("Mailbox added", `You can send from ${mailbox.address} now.`);
      onCreated(mailbox.id);
    } catch (error) {
      notifyError(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      <Input
        type="email"
        size="sm"
        autoFocus
        aria-label="New mailbox address"
        placeholder={`hello@${domains[0]?.name}`}
        value={address}
        onChange={(event) => setAddress(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); create(); }
          else if (event.key === "Escape" && onCancel) { event.stopPropagation(); onCancel(); }
        }}
      />
      <Button size="sm" variant="outline" disabled={busy || !EMAIL.test(address.trim())} onClick={create}>
        {busy ? <Spinner /> : null} Add mailbox
      </Button>
      {onCancel && <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>}
    </div>
  );
}
