export type View =
  | "inbox" | "starred" | "snoozed" | "sent" | "drafts" | "purchases"
  | "spam" | "scheduled" | "all" | "important" | "trash" | "archive" | "assigned" | "unassigned" | "support";

export const VIEW_TITLES: Record<View, string> = {
  inbox: "Inbox", starred: "Starred", snoozed: "Snoozed", sent: "Sent", drafts: "Drafts",
  purchases: "Purchases", spam: "Spam", scheduled: "Scheduled", all: "All mail",
  important: "Important", trash: "Trash", archive: "Archive", assigned: "Assigned to me", unassigned: "Unassigned", support: "Support",
};

export const SUPPORT_STATUS_LABELS = { open: "Open", in_progress: "In progress", solved: "Solved" } as const;
export type SupportStatus = keyof typeof SUPPORT_STATUS_LABELS;

// Views about who has a conversation. Assigning needs a paid plan, so the free plan hides them.
export const TEAM_VIEWS: ReadonlySet<View> = new Set(["assigned", "unassigned"]);

export interface MailFilter {
  view: View;
  labelId?: string;
  mailboxId?: string;
}

export interface ComposeState {
  key: number;
  draftId?: string;
  mailboxId?: string;
  threadId?: string | null;
  replyToMessageId?: string | null;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  html?: string;
  uploadIds?: string[];
}

export const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function formatListTime(value: string | Date) {
  const date = new Date(value);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

export const formatFullTime = (value: string | Date) =>
  new Date(value).toLocaleString(undefined, {
    weekday: "short", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
  });

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export const SNOOZES = [
  { label: "Later today", hours: 4 },
  { label: "Tomorrow", hours: 24 },
  { label: "Next week", hours: 24 * 7 },
];

export const CATEGORIES = ["primary", "notifications", "newsletters", "purchases"] as const;
