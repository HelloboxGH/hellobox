"use client";

import {
  Archive, ArrowArcLeft, ArrowArcRight, ArrowBendDoubleUpLeft, ArrowLeft, CheckCircle, ClockCountdown,
  CaretDown, DotsThree, EnvelopeSimple, FileHtml, FilePdf, ImageSquare, Lightning, LockSimple, NotePencil, Question, Robot, SealCheck, ShieldWarning,
  Sparkle, Star, Tag, Timer, Trash, Tray, WarningCircle,
} from "@phosphor-icons/react";
import Link from "next/link";
import { Fragment, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ACCENTS, useAccent, useIsDark } from "@/components/theme";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { InputGroup, InputGroupAddon } from "@/components/ui/input-group";
import {
  Menu, MenuCheckboxItem, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator, MenuTrigger,
} from "@/components/ui/menu";
import { Callout } from "@/components/callout";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { type Bootstrap, call, type ThreadDetail, type ThreadMessage } from "@/core/client/api";
import { toastManager } from "@/components/ui/toast";
import { errorMessage, notify, notifyError } from "@/core/client/notify";
import { openSealed, useVault } from "@/core/client/vault";
import { UnlockVault } from "@/components/settings/encryption";
import { AttachmentList } from "./attachment-list";
import { downloadHtml, exportFilename, printAsPdf, threadDocument } from "./export";
import { LabelChip, LabelIcon } from "./label-style";
import { IconAction } from "./icon-action";
import { MentionInput, withMentions } from "./mention-input";
import { SenderAvatar } from "./sender-avatar";
import { quotedTextHtml, replyAddresses } from "@/core/reply";
import { cn } from "@/lib/utils";
import { SupportPanel } from "./support-panel";
import { type ComposeState, escapeHtml, formatFullTime, formatListTime, SNOOZES, SUPPORT_STATUS_LABELS, type SupportStatus } from "./types";

const UNASSIGNED = "unassigned";

// Senders who style their own email get it as designed, on white, because forcing
// colors onto it can make text unreadable. Plain emails take on the app's theme.
const hasOwnStyling = (html: string) =>
  /bgcolor|background|(^|[\s;"'])color\s*:|<font[^>]+color|<style/i.test(html);

// Layered with server-side sanitizing: no scripts can run, and remote images
// only load if the user allowed them.
function emailDocument(
  html: string,
  allowRemote: boolean,
  colors: { text: string; muted: string; link: string; line: string; scheme: string; ground: string },
) {
  const images = allowRemote ? "https: data:" : "'self' data: https://*.r2.cloudflarestorage.com";
  const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src ${images}; font-src https: data:`;
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="color-scheme" content="${colors.scheme}"><base target="_blank"><style>:root{color-scheme:${colors.scheme}}body{margin:0;padding:16px;font:14px/1.6 system-ui,sans-serif;color:${colors.text};background:${colors.ground};overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}blockquote{margin:8px 0;padding-left:12px;border-left:2px solid ${colors.line};color:${colors.muted}}a{color:${colors.link}}${allowRemote ? "" : 'img[src^="http"]{display:none}'}</style></head><body>${html}</body></html>`;
}

function EmailFrame({ html, allowRemote }: { html: string; allowRemote: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const dark = useIsDark();
  const accent = useAccent();
  const designed = hasOwnStyling(html);
  const measure = useCallback(() => {
    const doc = frame.current?.contentDocument;
    if (doc?.documentElement && frame.current) {
      frame.current.style.height = `${doc.documentElement.scrollHeight + 2}px`;
    }
  }, []);
  const hue = ACCENTS.find((item) => item.value === accent)?.color ?? "";
  const themed = dark && !designed;
  const colors = {
    text: themed ? "#e8e8ee" : "#26262b",
    muted: themed ? "#a3a3ad" : "#555",
    line: themed ? "#3a3a44" : "#ddd",
    link: `color-mix(in oklch, ${hue} ${themed ? "70%, white" : "75%, black"})`,
    scheme: themed ? "dark" : "light",
    ground: themed ? "transparent" : "#fff",
  };
  return (
    <iframe
      ref={frame}
      title="Email content"
      // same-origin lets us measure the height. Without allow-scripts, nothing inside can run.
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={emailDocument(html, allowRemote, colors)}
      onLoad={measure}
      className="w-full rounded-xl border border-border"
      style={{ height: 120, colorScheme: colors.scheme, background: themed ? "transparent" : "#fff" }}
    />
  );
}

// Quarantined mail is deleted by maintenance, which runs every 15 minutes.
function expiryText(expiresAt: string | Date) {
  const hours = (new Date(expiresAt).getTime() - Date.now()) / 3_600_000;
  if (hours <= 1) return "This will be deleted within the hour.";
  return `This will be deleted automatically in about ${Math.round(hours)} hours.`;
}

type Recipient = { address: string; name?: string };

const person = (entry: Recipient) => (entry.name ? `${entry.name} <${entry.address}>` : entry.address);
const firstName = (entry: Recipient) => entry.name?.split(/\s+/)[0] || entry.address;

// "to Ada, bob@example.com +2", the short line under the sender, like most mail apps.
function recipientSummary(message: ThreadMessage) {
  const everyone = [...message.toRecipients, ...message.ccRecipients, ...message.bccRecipients];
  if (!everyone.length) return "to undisclosed recipients";
  const shown = everyone.slice(0, 2).map(firstName).join(", ");
  return `to ${shown}${everyone.length > 2 ? ` +${everyone.length - 2}` : ""}`;
}

const AUTH_LABELS = { spf: "SPF", dkim: "DKIM", dmarc: "DMARC" } as const;

// The full header, opened from the "to …" line: who sent it, who got it, when, and
// whether the sender's domain vouched for it.
function MessageDetails({ message }: { message: ThreadMessage }) {
  const replyTo = message.replyTo.filter((address) => address.toLowerCase() !== message.fromAddress.toLowerCase());
  const auth = message.authentication;
  const checks = auth
    ? (Object.keys(AUTH_LABELS) as (keyof typeof AUTH_LABELS)[]).flatMap((key) => (auth[key] ? [{ key, result: auth[key] }] : []))
    : [];
  const rows: { label: string; value: ReactNode }[] = [
    {
      label: "from",
      value: (
        <>
          <span className="font-medium text-foreground">{message.fromName || message.fromAddress}</span>
          {message.fromName && <span className="text-muted-foreground"> &lt;{message.fromAddress}&gt;</span>}
        </>
      ),
    },
    ...(replyTo.length ? [{ label: "reply-to", value: replyTo.join(", ") }] : []),
    { label: "to", value: message.toRecipients.map(person).join(", ") || "undisclosed recipients" },
    ...(message.ccRecipients.length ? [{ label: "cc", value: message.ccRecipients.map(person).join(", ") }] : []),
    ...(message.bccRecipients.length ? [{ label: "bcc", value: message.bccRecipients.map(person).join(", ") }] : []),
    { label: "date", value: formatFullTime(message.sentAt) },
    { label: "subject", value: message.subject || "(no subject)" },
    ...(checks.length
      ? [{
          label: "security",
          value: (
            <span className="flex flex-wrap gap-x-3 gap-y-1">
              {checks.map(({ key, result }) => {
                const pass = result === "pass";
                const Icon = pass ? SealCheck : result === "fail" ? WarningCircle : Question;
                return (
                  <span key={key} className={cn("inline-flex items-center gap-1", result === "fail" && "text-destructive-foreground")}>
                    <Icon className={cn("size-3.5", pass ? "text-success" : result === "fail" ? "text-destructive" : "text-muted-foreground")} />
                    {AUTH_LABELS[key]} {result}
                  </span>
                );
              })}
            </span>
          ),
        }]
      : []),
    ...(message.unscanned && message.direction === "inbound" ? [{ label: "scan", value: "Not checked for spam (the scanner was unavailable)" }] : []),
  ];
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
      {rows.map((row) => (
        <Fragment key={row.label}>
          <dt className="text-end text-muted-foreground">{row.label}:</dt>
          <dd className="break-words text-foreground">{row.value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

function MessageView({
  message, collapsed, onToggle, spam, showSender, showImages, onShowImages, onReply, onForward, onImagesAllowed,
}: {
  message: ThreadMessage;
  // Older messages show one line until opened, like Gmail.
  collapsed: boolean;
  onToggle: () => void;
  spam: boolean;
  // Says which teammate sent a reply. Only worth saying when there's a team.
  showSender: boolean;
  showImages: boolean;
  onShowImages: () => void;
  onReply: () => void;
  onForward: () => void;
  onImagesAllowed: () => void;
}) {
  const name = message.fromName || message.fromAddress;
  const failed = message.deliveryStatus && ["bounced", "failed", "complained"].includes(message.deliveryStatus);
  const senderDomain = message.fromAddress.slice(message.fromAddress.lastIndexOf("@") + 1).toLowerCase();
  const toUnknown = message.toUnknownRecipient;
  const [neverSpam, setNeverSpam] = useState(false);
  if (collapsed) {
    const preview = message.sealedBody
      ? "Encrypted message"
      : (message.textBody ?? (message.htmlBody ?? "").replace(/<(style|script)[\s\S]*?<\/\1>|<[^>]+>/gi, " "))
          .replace(/\s+/g, " ").trim();
    return (
      <article>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={false}
          className="flex w-full items-center gap-3 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <SenderAvatar name={name} />
          <span className="min-w-0 flex-1 truncate text-sm">
            <span className="font-medium text-foreground">{name}</span>
            {preview && <span className="text-muted-foreground"> · {preview}</span>}
          </span>
          <time dateTime={new Date(message.sentAt).toISOString()} className="shrink-0 text-muted-foreground text-xs">
            {formatListTime(message.sentAt)}
          </time>
        </button>
      </article>
    );
  }
  return (
    <article className="py-5">
      <header className="mb-3 flex items-start gap-3">
        <button type="button" onClick={onToggle} aria-label="Collapse message" className="shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <SenderAvatar name={name} />
        </button>
        <div className="min-w-0 flex-1">
          {/* Clicking the sender line closes the message again, like the avatar does. The avatar
              is the keyboard way in; badges and links inside keep their own clicks. */}
          <div
            className="flex cursor-pointer items-baseline gap-2"
            onClick={(event) => {
              if ((event.target as HTMLElement).closest("button, a, [role='button']")) return;
              if (window.getSelection()?.toString()) return;
              onToggle();
            }}
          >
            <p className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5 text-sm">
              <span className="truncate font-semibold text-foreground">{name}</span>
              {message.fromName && <span className="min-w-0 truncate text-muted-foreground text-xs">&lt;{message.fromAddress}&gt;</span>}
              {message.sentByAgent && (
                <Tooltip>
                  <TooltipTrigger render={<Badge variant="outline" size="sm" className="shrink-0 self-center" />}>
                    <Robot />
                    Agent
                  </TooltipTrigger>
                  <TooltipPopup>Sent by {message.sentByAgent} on someone&apos;s behalf</TooltipPopup>
                </Tooltip>
              )}
              {showSender && !message.sentByAgent && message.sentBy && (
                <span className="shrink-0 text-muted-foreground text-xs">· sent by {message.sentBy}</span>
              )}
            </p>
            <time dateTime={new Date(message.sentAt).toISOString()} title={formatFullTime(message.sentAt)} className="shrink-0 text-muted-foreground text-xs">
              <span className="sm:hidden">{formatListTime(message.sentAt)}</span>
              <span className="hidden sm:inline">{formatFullTime(message.sentAt)}</span>
            </time>
          </div>
          <Popover>
            <PopoverTrigger
              render={
                <button
                  type="button"
                  aria-label="Show message details"
                  className="-mx-1 flex max-w-full items-center gap-0.5 rounded px-1 text-muted-foreground text-xs outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                />
              }
            >
              <span className="truncate">{recipientSummary(message)}</span>
              <CaretDown className="size-3 shrink-0" />
            </PopoverTrigger>
            <PopoverPopup align="start" className="w-[min(30rem,calc(100vw-2rem))]">
              <MessageDetails message={message} />
            </PopoverPopup>
          </Popover>
        </div>
      </header>

      <div className="space-y-3">
        {Boolean(message.spamReasons?.length) && spam && (
          <Callout
            tone="warning"
            icon={<ShieldWarning />}
            actions={
              !toUnknown && senderDomain && !neverSpam ? (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={async () => {
                    try {
                      await call("/account/spam-exemptions/add", { domain: senderDomain });
                      setNeverSpam(true);
                      notify(`${senderDomain} won't go to Spam`, "For mail that arrives from now on. Change this in Settings, under Rules.");
                    } catch (error) {
                      notifyError(error);
                    }
                  }}
                >
                  Never spam {senderDomain}
                </Button>
              ) : undefined
            }
          >
            {toUnknown
              ? "This was sent to an address that has no mailbox, so it was kept here instead of creating one. Add the mailbox in settings if you want this address."
              : <>Marked as spam: {message.spamReasons?.join(", ")}</>}
          </Callout>
        )}
        {message.hasRemoteImages && !showImages && (
          <Callout
            tone="neutral"
            icon={<ImageSquare />}
            actions={
              <>
                <Button size="xs" variant="outline" onClick={onShowImages}>Load images</Button>
                {!spam && (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={async () => {
                      try {
                        await call("/threads/allow-images", { address: message.fromAddress });
                        onShowImages();
                        onImagesAllowed();
                      } catch (error) {
                        notifyError(error);
                      }
                    }}
                  >
                    Always from this sender
                  </Button>
                )}
              </>
            }
          >
            Remote images are blocked, so the sender can&apos;t see when you open this.
          </Callout>
        )}
        {message.sealedBody && !message.locked && (
          <p className="flex items-center gap-1.5 text-muted-foreground text-xs">
            <LockSimple aria-hidden />
            Encrypted. Search, AI and agents can&apos;t read this message.
          </p>
        )}
        {message.locked ? (
          <UnlockVault />
        ) : message.htmlBody ? (
          <EmailFrame html={message.htmlBody} allowRemote={showImages} />
        ) : (
          <p className="whitespace-pre-wrap text-foreground text-sm leading-relaxed">{message.textBody}</p>
        )}
        {message.attachments.length > 0 && (
          <AttachmentList files={message.attachments} previews={!spam} />
        )}
        {message.direction === "outbound" && message.deliveryStatus && (
          <DeliveryStatus status={message.deliveryStatus} recipients={message.deliveryRecipients} failed={Boolean(failed)} />
        )}
      </div>

      <div className="mt-4 flex gap-2">
        <Button variant="outline" onClick={onReply}><ArrowArcLeft /> Reply</Button>
        <Button variant="outline" onClick={onForward}><ArrowArcRight /> Forward</Button>
      </div>
    </article>
  );
}

async function openMessages(detail: ThreadDetail): Promise<ThreadDetail> {
  if (!detail.messages.some((message) => message.sealedBody)) return detail;
  const messages = await Promise.all(
    detail.messages.map(async (message) => {
      if (!message.sealedBody) return message;
      const content = await openSealed(message.sealedBody).catch(() => null);
      if (!content) return { ...message, locked: true };
      const html = content.html
        ? content.html.replace(/(["'])cid:([^"']+)\1/gi, (match, q: string, id: string) =>
            message.inlineImages[id] ? `${q}${message.inlineImages[id]}${q}` : match)
        : null;
      return {
        ...message,
        locked: false,
        textBody: content.text,
        htmlBody: html,
        snippet: (content.text ?? "").slice(0, 200),
        hasRemoteImages: html ? /<img[^>]+src=["']?https?:/i.test(html) || /url\(\s*["']?https?:/i.test(html) : false,
        attachments: message.attachments.filter((file) => !(file.contentId && content.html?.includes(`cid:${file.contentId}`))),
      };
    }),
  );
  return { ...detail, messages };
}

const quote = (message: ThreadMessage) =>
  `<p><br></p><blockquote>On ${escapeHtml(formatFullTime(message.sentAt))}, ${escapeHtml(message.fromAddress)} wrote:<br>${quotedTextHtml(message.textBody ?? message.snippet)}</blockquote>`;

function ReaderSkeleton() {
  return (
    <div className="space-y-4 p-6">
      <Skeleton className="h-6 w-3/5" />
      <div className="flex gap-3"><Skeleton className="size-8 rounded-full" /><Skeleton className="h-8 w-48" /></div>
      <Skeleton className="h-48 w-full rounded-xl" />
    </div>
  );
}

export function Reader({
  threadId, data, refreshKey, onBack, onCompose, onChanged, onToggleAi,
}: {
  threadId: string;
  data: Bootstrap;
  refreshKey: number;
  onBack: () => void;
  onCompose: (state: Omit<ComposeState, "key">) => void;
  onChanged: () => void;
  onToggleAi: () => void;
}) {
  const [loaded, setLoaded] = useState<ThreadDetail | null>(null);
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const vault = useVault();
  // Sealed messages are opened here, so replies, quotes and downloads see the plain text.
  useEffect(() => {
    let current = true;
    if (!loaded) return;
    openMessages(loaded).then((opened) => { if (current) setDetail(opened); });
    return () => { current = false; };
  }, [loaded, vault.key]);
  const [failed, setFailed] = useState<string | null>(null);
  const [note, setNote] = useState("");
  // Opened or closed by hand. Otherwise only the newest message is open.
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  // Messages whose remote images this person loaded, so a download shows what they saw.
  const [imagesLoaded, setImagesLoaded] = useState<ReadonlySet<string>>(new Set());
  const [team, setTeam] = useState<Awaited<ReturnType<typeof call<"/members/list">>>["members"]>([]);
  const shared = data.entitlements.features.team;
  useEffect(() => {
    if (shared) call("/members/list").then((result) => setTeam(result.members)).catch(() => undefined);
  }, [shared]);

  const load = useCallback(
    () =>
      call("/threads/get", { id: threadId })
        .then((next) => {
          setLoaded(next);
          setFailed(null);
        })
        .catch((error: unknown) => setFailed(errorMessage(error))),
    [threadId],
  );

  // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshKey reloads on new mail
  useEffect(() => {
    load();
  }, [load, refreshKey]);

  // Marks as read once per opened conversation. The parent remounts this per thread.
  const markedRead = useRef(false);
  useEffect(() => {
    if (markedRead.current) return;
    markedRead.current = true;
    call("/threads/update", { ids: [threadId], read: true }).then(onChanged).catch(() => undefined);
  }, [threadId, onChanged]);

  const update = useCallback(
    async (patch: Omit<Parameters<typeof call<"/threads/update">>[1], "ids">, message?: string, leave = false) => {
      try {
        await call("/threads/update", { ids: [threadId], ...patch });
        if (message) notify(message);
        onChanged();
        if (leave) onBack();
        else load();
      } catch (error) {
        notifyError(error);
      }
    },
    [threadId, onChanged, onBack, load],
  );

  const setStatus = useCallback(
    async (status: SupportStatus) => {
      try {
        await call("/support/status", { threadIds: [threadId], status });
        notify(status === "solved" ? "Solved and archived" : `Marked ${SUPPORT_STATUS_LABELS[status].toLowerCase()}`);
        onChanged();
        load();
      } catch (error) {
        notifyError(error);
      }
    },
    [threadId, onChanged, load],
  );

  const replyFrom = useCallback(
    (message: ThreadMessage, all: boolean) => {
      if (!detail) return;
      const primary = replyAddresses(message, detail.support);
      const mailbox = data.mailboxes.find((m) => m.id === detail.thread.mailboxId)?.address;
      const cc = all
        ? [...message.toRecipients, ...message.ccRecipients].map((r) => r.address).filter((a) => a !== mailbox && !primary.includes(a))
        : [];
      onCompose({
        mailboxId: detail.thread.mailboxId,
        threadId: detail.thread.id,
        replyToMessageId: message.id,
        to: primary,
        cc,
        subject: /^re:/i.test(message.subject) ? message.subject : `Re: ${message.subject}`,
        html: quote(message),
      });
    },
    [detail, data.mailboxes, onCompose],
  );

  const forward = useCallback(
    (message: ThreadMessage) => {
      if (!detail) return;
      onCompose({
        mailboxId: detail.thread.mailboxId,
        subject: /^fwd:/i.test(message.subject) ? message.subject : `Fwd: ${message.subject}`,
        html: quote(message),
      });
    },
    [detail, onCompose],
  );

  useEffect(() => {
    if (!detail) return;
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (target.closest("input,textarea,[contenteditable],[role=dialog]")) return;
      const latest = detail?.messages.at(-1);
      if (event.key === "r" && latest) { event.preventDefault(); replyFrom(latest, false); }
      else if (event.key === "a" && latest) { event.preventDefault(); replyFrom(latest, true); }
      else if (event.key === "f" && latest) { event.preventDefault(); forward(latest); }
      else if (event.key === "e") { event.preventDefault(); update({ folder: "archive" }, "Archived", true); }
      else if (event.key === "s") { event.preventDefault(); update({ starred: !detail?.starred }); }
      else if (event.key === "#") { event.preventDefault(); update({ folder: "trash" }, "Moved to trash", true); }
      else if (event.key === "Escape") onBack();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail, replyFrom, forward, update, onBack]);

  if (failed) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyTitle>We couldn&apos;t open this conversation</EmptyTitle>
          <EmptyDescription>{failed}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent><Button variant="outline" onClick={load}>Try again</Button></EmptyContent>
      </Empty>
    );
  }
  if (!detail) return <ReaderSkeleton />;

  const { thread, messages } = detail;
  const showsImages = (message: ThreadMessage) => message.imagesAllowed || imagesLoaded.has(message.id);
  const download = (format: "html" | "pdf") => {
    const html = threadDocument({
      subject: thread.subject,
      messages,
      origin: window.location.origin,
      imagesShown: showsImages,
    });
    const filename = exportFilename(thread.subject, messages.at(-1)?.sentAt ?? thread.lastMessageAt);
    if (format === "html") downloadHtml(html, filename);
    else printAsPdf(html, filename);
  };
  const assignees = [
    { label: "No one", value: UNASSIGNED },
    ...team
      .filter((member) => member.mailboxIds.includes(thread.mailboxId))
      .map((member) => ({ label: member.name, value: member.userId })),
  ];
  const mentionable = team
    .filter((member) => member.userId !== data.user.id && member.mailboxIds.includes(thread.mailboxId))
    .map((member) => ({ id: member.userId, name: member.name, image: member.image }));
  const latest = messages.at(-1);

  return (
    <section aria-label="Conversation" className="motion-reading flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-0.5 border-b p-2">
        <IconAction label="Back" shortcut="Esc" onClick={onBack} className="lg:hidden"><ArrowLeft /></IconAction>
        {latest && <IconAction label="Reply" shortcut="R" onClick={() => replyFrom(latest, false)}><ArrowArcLeft /></IconAction>}
        {latest && <IconAction label="Reply all" shortcut="A" onClick={() => replyFrom(latest, true)}><ArrowBendDoubleUpLeft /></IconAction>}
        {latest && <IconAction label="Forward" shortcut="F" onClick={() => forward(latest)}><ArrowArcRight /></IconAction>}
        <Separator orientation="vertical" className="mx-1 h-5" />
        <IconAction label={detail.starred ? "Remove star" : "Star"} shortcut="S" onClick={() => update({ starred: !detail.starred })}>
          <Star weight={detail.starred ? "fill" : "regular"} className={detail.starred ? "text-star" : undefined} />
        </IconAction>
        {thread.folder === "inbox" ? (
          <IconAction label="Archive" shortcut="E" onClick={() => update({ folder: "archive" }, "Archived", true)}><Archive /></IconAction>
        ) : (
          <IconAction label="Move to inbox" onClick={() => update({ folder: "inbox" }, "Moved to inbox")}><Tray /></IconAction>
        )}
        {thread.folder === "spam" ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              await call("/threads/report-sender", { ids: [threadId], verdict: "not_spam" });
              notify("Moved to inbox", "This sender is now allowed.");
              onChanged();
              load();
            }}
          >
            <CheckCircle /> Not spam
          </Button>
        ) : (
          <IconAction
            label="Report spam"
            onClick={async () => {
              const { senders: [sender] } = await call("/threads/report-sender", { ids: [threadId], verdict: "spam" });
              onChanged();
              onBack();
              if (!sender) return notify("Moved to spam");
              // Blocking is a separate choice: one bad message shouldn't silence someone for good.
              const toastId = toastManager.add({
                title: "Moved to spam",
                description: `Block ${sender} to send their future mail straight to Spam.`,
                type: "success",
                timeout: 10_000,
                actionProps: {
                  children: "Block sender",
                  onClick: async () => {
                    toastManager.close(toastId);
                    try {
                      await call("/threads/block-sender", { threadId });
                      notify(`${sender} blocked`, "Undo this in Settings, under Rules.");
                    } catch (error) {
                      notifyError(error);
                    }
                  },
                },
              });
            }}
          >
            <ShieldWarning />
          </IconAction>
        )}
        {thread.folder === "trash" ? (
          <Button
            size="sm"
            variant="destructive-outline"
            onClick={async () => {
              await call("/threads/delete", { ids: [threadId] });
              notify("Deleted forever");
              onChanged();
              onBack();
            }}
          >
            Delete forever
          </Button>
        ) : (
          <IconAction label="Move to trash" shortcut="#" onClick={() => update({ folder: "trash" }, "Moved to trash", true)}><Trash /></IconAction>
        )}
        <Menu>
          <MenuTrigger render={<Button aria-label="Snooze" size="icon-sm" variant="ghost" />}><ClockCountdown /></MenuTrigger>
          <MenuPopup align="start">
            <MenuGroup>
              <MenuGroupLabel>Snooze until</MenuGroupLabel>
              {SNOOZES.map((item) => (
                <MenuItem
                  key={item.label}
                  onClick={() => update({ snoozedUntil: new Date(Date.now() + item.hours * 3_600_000).toISOString() }, `Snoozed until ${item.label.toLowerCase()}`, true)}
                >
                  {item.label}
                </MenuItem>
              ))}
            </MenuGroup>
          </MenuPopup>
        </Menu>
        <Menu>
          <MenuTrigger render={<Button aria-label="Labels" size="icon-sm" variant="ghost" />}><Tag /></MenuTrigger>
          <MenuPopup align="start">
            <MenuGroup>
              <MenuGroupLabel>Labels</MenuGroupLabel>
              {data.labels.length === 0 && <MenuItem disabled>Create a label in the sidebar</MenuItem>}
              {data.labels.map((label) => {
                const applied = detail.labels.some((l) => l.id === label.id);
                return (
                  <MenuCheckboxItem
                    key={label.id}
                    checked={applied}
                    onCheckedChange={async (checked) => {
                      await call("/threads/label", { ids: [threadId], labelId: label.id, applied: checked });
                      load();
                      onChanged();
                    }}
                  >
                    <span className="flex items-center gap-2"><LabelIcon label={label} /> {label.name}</span>
                  </MenuCheckboxItem>
                );
              })}
            </MenuGroup>
          </MenuPopup>
        </Menu>
        <Menu>
          <MenuTrigger render={<Button aria-label="More actions" size="icon-sm" variant="ghost" />}><DotsThree weight="bold" /></MenuTrigger>
          <MenuPopup align="start">
            <MenuItem onClick={() => update({ read: false }, undefined, true)}><EnvelopeSimple /> Mark as unread</MenuItem>
            <MenuItem onClick={() => update({ important: !thread.important })}>
              <Lightning weight={thread.important ? "fill" : "regular"} /> {thread.important ? "Not important" : "Mark important"}
            </MenuItem>
            <MenuSeparator />
            <MenuItem onClick={() => download("html")}><FileHtml /> Download as HTML</MenuItem>
            <MenuItem onClick={() => download("pdf")}><FilePdf /> Download as PDF</MenuItem>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>Move to</MenuGroupLabel>
              {(["primary", "notifications", "newsletters", "purchases"] as const)
                .filter((category) => category !== thread.category)
                .map((category) => (
                  <MenuItem key={category} className="capitalize" onClick={() => update({ category }, `Moved to ${category}`)}>{category}</MenuItem>
                ))}
            </MenuGroup>
          </MenuPopup>
        </Menu>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" className="text-brand-foreground" onClick={onToggleAi}>
          <Sparkle weight="fill" /> <span className="hidden sm:inline">Draft with AI</span>
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="@container">
        <div className={cn("mx-auto px-5 pb-6", detail.support ? "flex max-w-5xl flex-col @xl:flex-row-reverse @xl:gap-5" : "max-w-3xl")}>
          {detail.support && <SupportPanel support={detail.support} onStatus={setStatus} />}
          <div className="min-w-0 flex-1">
          <h2 className="text-balance pt-6 font-heading font-semibold text-foreground text-xl tracking-tight">{thread.subject || "(no subject)"}</h2>
          {detail.labels.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {detail.labels.map((label) => <LabelChip key={label.id} label={label} size="default" />)}
            </div>
          )}
          {thread.expiresAt && (
            <div className="mt-4">
              <Callout tone="neutral" icon={<Timer />}>
                {expiryText(thread.expiresAt)} It didn&apos;t count toward your storage. Move it to your inbox to keep it.
              </Callout>
            </div>
          )}
          <div className="divide-y">
            {messages.map((message, index) => (
              <MessageView
                key={message.id}
                message={message}
                collapsed={(index !== messages.length - 1) !== toggled.has(message.id)}
                onToggle={() => setToggled((ids) => {
                  const next = new Set(ids);
                  if (!next.delete(message.id)) next.add(message.id);
                  return next;
                })}
                spam={thread.folder === "spam"}
                showSender={shared}
                showImages={showsImages(message)}
                onShowImages={() => setImagesLoaded((ids) => new Set(ids).add(message.id))}
                onReply={() => replyFrom(message, false)}
                onForward={() => forward(message)}
                onImagesAllowed={load}
              />
            ))}
          </div>

          {data.entitlements.features.team && (
            <section aria-label="Internal notes" className="mt-2 rounded-xl bg-brand-soft p-3">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <span className="font-medium text-brand-foreground text-xs">Assigned to</span>
                <Select
                  value={thread.assignedTo ?? UNASSIGNED}
                  items={assignees}
                  onValueChange={(value) => update({ assignedTo: value === UNASSIGNED ? null : value }, "Assignment updated")}
                >
                  <SelectTrigger size="sm" aria-label="Assign this conversation" className="w-48 bg-background"><SelectValue /></SelectTrigger>
                  <SelectPopup>{assignees.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectPopup>
                </Select>
              </div>
              <h3 className="mb-2 flex items-center gap-2 font-medium text-brand-foreground text-xs"><NotePencil /> Only your team sees these notes</h3>
              {detail.notes.map((item) => (
                <p key={item.id} className="mb-2 text-foreground text-sm">
                  <span className="font-medium">{item.author}:</span>{" "}
                  {withMentions(item.body, team.filter((member) => item.mentions.includes(member.userId)).map((member) => member.name))}
                  <time dateTime={new Date(item.createdAt).toISOString()} title={formatFullTime(item.createdAt)} className="ms-2 text-muted-foreground text-xs">
                    {formatListTime(item.createdAt)}
                  </time>
                </p>
              ))}
              <form
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (!note.trim()) return;
                  const result = await call("/threads/note", { threadId, body: note });
                  if (result.mentioned) notify("Note added", `${result.mentioned} ${result.mentioned === 1 ? "teammate" : "teammates"} notified.`);
                  setNote("");
                  load();
                }}
              >
                <InputGroup>
                  <MentionInput
                    ariaLabel="Add a note"
                    placeholder="Add a note, @ to mention a teammate"
                    value={note}
                    onChange={setNote}
                    people={mentionable}
                    className="h-8.5 px-[calc(--spacing(3)-1px)] text-foreground sm:h-7.5 sm:text-sm"
                  />
                  <InputGroupAddon align="inline-end"><Button type="submit" size="xs" variant="ghost">Add</Button></InputGroupAddon>
                </InputGroup>
              </form>
            </section>
          )}
          </div>
        </div>
        </div>
      </ScrollArea>
    </section>
  );
}

const DELIVERY_LABELS: Record<string, string> = {
  delivered: "Delivered",
  delayed: "Delayed",
  bounced: "Bounced",
  complained: "Reported as spam",
  failed: "Not sent",
};

const PROBLEM_LABELS: Record<string, string> = {
  delayed: "is delayed",
  bounced: "bounced",
  complained: "reported this as spam",
  failed: "wasn't sent",
};

// The summary badge, then each recipient with a problem and what their server said. A
// bounce or spam report also explains that the address is now suppressed.
function DeliveryStatus({ status, recipients, failed }: {
  status: string;
  recipients: Record<string, { status: string; reason?: string; at: string }>;
  failed: boolean;
}) {
  const problems = Object.entries(recipients).filter(([, entry]) => entry.status in PROBLEM_LABELS);
  const suppressed = problems.some(([email, entry]) => email !== "*" && (entry.status === "bounced" || entry.status === "complained"));
  return (
    <div className="space-y-1.5">
      <Badge variant={failed ? "error" : "secondary"} size="sm">{DELIVERY_LABELS[status] ?? status}</Badge>
      {problems.length > 0 && (
        <ul className="space-y-0.5 text-muted-foreground text-xs">
          {problems.map(([email, entry]) => (
            <li key={email} className="break-words">
              <span className="text-foreground">{email === "*" ? "This email" : email}</span> {PROBLEM_LABELS[entry.status]}
              {entry.reason && <>: {entry.reason}</>}
            </li>
          ))}
        </ul>
      )}
      {suppressed && (
        <p className="text-muted-foreground text-xs">
          HelloBox won&apos;t send to these addresses again unless you choose to. See{" "}
          <Link href="/settings?tab=suppressions" className="underline underline-offset-2 hover:text-foreground">Suppressed addresses</Link>.
        </p>
      )}
    </div>
  );
}
