"use client";

import { ArrowSquareOut, ChatCircleDots, Code, EnvelopeSimple, Key, MagnifyingGlass, SealCheck } from "@phosphor-icons/react";
import type { ProviderTile } from "@hellobox/extensions";
import type { ProviderKind } from "@hellobox/providers/types";
import { type FormEvent, type ReactNode, useMemo, useState } from "react";
import { AmazonSesIcon, BirdIcon, BrevoIcon, MailerSendIcon, MailgunIcon, MailjetIcon, PostmarkIcon, ResendIcon, SendGridIcon } from "@/components/brand-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { fuzzySearch } from "@/lib/fuzzy-search";

// Whether each provider can be picked here: ready to connect, already connected (Resend
// allows one), or not built yet, which asks for a vote instead.
export type ProviderAvailability = Record<ProviderKind, "ready" | "connected" | "soon" | "hidden">;

// Aliases are other names people search by. Keywords match weakly.
const CHOICES: { kind: ProviderKind; name: string; detail: string; icon: ReactNode; aliases?: string[]; keywords?: string[] }[] = [
  { kind: "ses", name: "Amazon SES", detail: "A CloudFormation stack in your AWS account", icon: <AmazonSesIcon className="size-6 rounded-[5px]" />, aliases: ["AWS", "Simple Email Service", "SES"] },
  { kind: "resend", name: "Resend", detail: "Sign in to Resend and allow access", icon: <ResendIcon className="size-5 text-foreground" /> },
  { kind: "postmark", name: "Postmark", detail: "Paste an account API token", icon: <PostmarkIcon className="size-6" />, aliases: ["ActiveCampaign Postmark"] },
  { kind: "mailgun", name: "Mailgun", detail: "Paste your API key and webhook signing key", icon: <MailgunIcon className="size-6 text-[#F06B66]" />, aliases: ["Sinch Mailgun"] },
  { kind: "bird", name: "Bird", detail: "Paste an access key", icon: <BirdIcon className="size-6 rounded-[5px]" />, aliases: ["SparkPost", "MessageBird"] },
  { kind: "mailjet", name: "Mailjet", detail: "Paste two keys", icon: <MailjetIcon className="size-6" /> },
  { kind: "mailersend", name: "MailerSend", detail: "Paste an API token", icon: <MailerSendIcon className="size-6" />, aliases: ["MailerLite"] },
  { kind: "brevo", name: "Brevo", detail: "Paste an API key", icon: <BrevoIcon className="size-6" />, aliases: ["Sendinblue"] },
  { kind: "sendgrid", name: "SendGrid", detail: "Paste an API key", icon: <SendGridIcon className="size-6" />, aliases: ["Twilio SendGrid"] },
  { kind: "smtp", name: "SMTP", detail: "A server, a username and a password", icon: <EnvelopeSimple className="size-6 text-muted-foreground" />, keywords: ["mail server", "relay", "Google Workspace", "Zoho", "Fastmail"] },
  { kind: "custom", name: "Custom provider", detail: "Describe any sending API yourself", icon: <Code className="size-6 text-muted-foreground" />, keywords: ["any API", "curl", "webhook", "other"] },
];

export const providerIcon = (kind: ProviderKind) => CHOICES.find((choice) => choice.kind === kind)?.icon;

// One square in the grid.
function Tile({ icon, name, detail, badge, verified, disabled, onClick }: {
  icon: ReactNode;
  name: string;
  detail: string;
  badge?: ReactNode;
  verified?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={detail}
      className="relative flex min-w-0 flex-col items-center gap-2 rounded-xl border p-3 pt-4 text-center outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60"
    >
      <span className="flex size-11 items-center justify-center overflow-hidden rounded-xl bg-muted text-muted-foreground">{icon}</span>
      <span className="flex w-full items-center justify-center gap-1 font-medium text-foreground text-sm">
        <span className="truncate">{name}</span>
        {verified && <SealCheck weight="fill" aria-label="Verified" className="size-4 shrink-0 text-info" />}
      </span>
      <span className="line-clamp-2 w-full text-muted-foreground text-xs leading-snug">{detail}</span>
      {badge && <span className="absolute top-2 right-2">{badge}</span>}
    </button>
  );
}

type Entry = { kind: "native"; choice: (typeof CHOICES)[number] } | { kind: "tile"; tile: ProviderTile };

const entryText = (entry: Entry) =>
  entry.kind === "native" ? entry.choice : { name: entry.tile.name, aliases: entry.tile.aliases, keywords: [...(entry.tile.keywords ?? []), entry.tile.category?.label ?? ""] };

export function ProviderPicker({ open, onOpenChange, availability, onPick, onRequest, tiles = [] }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  availability: ProviderAvailability;
  onPick: (kind: ProviderKind) => void;
  // Opens the request form, filled in with a provider that isn't built yet.
  onRequest: (provider?: string) => void;
  // More providers, from the directory. They go after the built-in ones, before SMTP and
  // Custom provider.
  tiles?: ProviderTile[];
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const categories = useMemo(() => {
    const seen = new Map<string, string>();
    if (availability.custom !== "hidden") for (const tile of tiles) if (tile.category) seen.set(tile.category.value, tile.category.label);
    return [...seen].map(([value, label]) => ({ value, label }));
  }, [tiles, availability.custom]);
  const shown = useMemo(() => {
    const natives = CHOICES.filter((choice) => availability[choice.kind] !== "hidden");
    // Listings are custom providers, so they need what Custom provider needs.
    const listed = availability.custom === "hidden" ? [] : tiles;
    const last = (choice: (typeof CHOICES)[number]) => choice.kind === "smtp" || choice.kind === "custom";
    const entries: Entry[] = category
      ? listed.filter((tile) => tile.category?.value === category).map((tile): Entry => ({ kind: "tile", tile }))
      : [
          ...natives.filter((choice) => !last(choice)).map((choice): Entry => ({ kind: "native", choice })),
          ...listed.map((tile): Entry => ({ kind: "tile", tile })),
          ...natives.filter(last).map((choice): Entry => ({ kind: "native", choice })),
        ];
    return fuzzySearch(entries, query, entryText);
  }, [availability, tiles, category, query]);
  const typed = query.trim();

  return (
    <Dialog open={open} onOpenChange={(next) => { onOpenChange(next); if (!next) { setQuery(""); setCategory(null); } }}>
      <DialogPopup className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Connect a provider</DialogTitle>
          <DialogDescription>Pick the service you send email with. Your mail keeps going through it.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3 pb-6">
          <InputGroup>
            <InputGroupAddon><MagnifyingGlass /></InputGroupAddon>
            <InputGroupInput
              autoFocus
              type="search"
              aria-label="Search providers"
              placeholder="Search providers"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </InputGroup>
          {categories.length > 0 && (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Category">
              {[{ value: null, label: "All" }, ...categories].map((item) => (
                <Button
                  key={item.value ?? "all"}
                  size="xs"
                  variant={category === item.value ? "default" : "outline"}
                  aria-pressed={category === item.value}
                  onClick={() => setCategory(item.value)}
                >
                  {item.label}
                </Button>
              ))}
            </div>
          )}
          {shown.length > 0 ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {shown.map((entry) => {
                if (entry.kind === "tile") {
                  const { tile } = entry;
                  return (
                    <Tile
                      key={tile.key}
                      icon={tile.icon}
                      name={tile.name}
                      detail={tile.detail}
                      verified={tile.verified}
                      badge={tile.featured ? <Badge variant="info">Featured</Badge> : undefined}
                      onClick={() => {
                        onOpenChange(false);
                        tile.onPick();
                      }}
                    />
                  );
                }
                const { choice } = entry;
                const state = availability[choice.kind];
                return (
                  <Tile
                    key={choice.kind}
                    icon={choice.icon}
                    name={choice.name}
                    detail={state === "soon" ? "Tell us you use it, and we'll build it sooner" : choice.detail}
                    badge={state === "connected" ? <Badge variant="success">Connected</Badge> : state === "soon" ? <Badge variant="outline">Soon</Badge> : undefined}
                    disabled={state === "connected"}
                    onClick={() => (state === "soon" ? onRequest(choice.name) : onPick(choice.kind))}
                  />
                );
              })}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-4 py-8 text-center">
              <MagnifyingGlass className="size-6 text-muted-foreground" />
              <p className="text-sm">Nothing called &ldquo;{typed}&rdquo; yet.</p>
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="outline" onClick={() => onRequest(typed)}><ChatCircleDots /> Ask for {typed}</Button>
                {availability.custom !== "hidden" && <Button variant="outline" onClick={() => onPick("custom")}><Code /> Describe its API</Button>}
              </div>
            </div>
          )}
          {shown.length > 0 && (
            <button
              type="button"
              onClick={() => onRequest(typed || undefined)}
              className="flex w-full items-center justify-center gap-2 rounded-xl p-2 text-muted-foreground text-sm outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChatCircleDots className="size-4" /> Using something else? Tell us
            </button>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

export interface KeyField {
  name: string;
  label: string;
  placeholder?: string;
  help: ReactNode;
  // Shown as typed, such as a server name. Keys and passwords stay hidden.
  plain?: boolean;
  defaultValue?: string;
}

export interface PasteKeyProvider {
  kind: "postmark" | "mailgun" | "smtp" | "sendgrid" | "brevo" | "mailersend" | "mailjet" | "bird";
  name: string;
  description: ReactNode;
  fields: KeyField[];
  // Where to find the key, opened in a new tab.
  link?: { href: string; label: string };
  // What we do with the key, under the fields.
  note: ReactNode;
}

export const PASTE_KEY_PROVIDERS: Record<PasteKeyProvider["kind"], PasteKeyProvider> = {
  postmark: {
    kind: "postmark",
    name: "Postmark",
    description: "Paste an Account API token. Only account owners and admins can see it.",
    fields: [
      {
        name: "token",
        label: "Account API token",
        placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
        help: "In Postmark, open Account, then API Tokens.",
      },
    ],
    link: { href: "https://account.postmarkapp.com/api_tokens", label: "Open Postmark API tokens" },
    note: "We use it to set up receiving and read your domains. Your mail sends from your own Postmark account.",
  },
  mailgun: {
    kind: "mailgun",
    name: "Mailgun",
    description: "Paste your API key and your HTTP webhook signing key. Both are under API Security in Mailgun.",
    fields: [
      {
        name: "apiKey",
        label: "API key",
        help: "Use a full API key. A domain sending key can only send, so it can't set up receiving.",
      },
      {
        name: "signingKey",
        label: "HTTP webhook signing key",
        help: "Lets HelloBox check that new-mail notifications really come from Mailgun.",
      },
    ],
    link: { href: "https://app.mailgun.com/settings/api_security", label: "Open Mailgun API Security" },
    note: "We use them to set up receiving and read your domains. Your mail sends from your own Mailgun account.",
  },
  bird: {
    kind: "bird",
    name: "Bird",
    description: "Paste a workspace access key. HelloBox sets up the webhook for delivery events and received mail with it.",
    fields: [
      {
        name: "apiKey",
        label: "Access key",
        placeholder: "bk_us1_xxxxxxxx",
        help: "In Bird, open Platform tools, then API keys, and create a key with email and webhook access. Bird shows it once.",
      },
    ],
    link: { href: "https://bird.com/dashboard/w/api-keys", label: "Open Bird API keys" },
    note: "We use it to read your domains, set up receiving and get delivery events. Your mail sends from your own Bird workspace.",
  },
  mailjet: {
    kind: "mailjet",
    name: "Mailjet",
    description: "Paste your API key and secret key. Both are under API Key Management in Mailjet.",
    fields: [
      { name: "apiKey", label: "API key", help: "The public key of the pair." },
      { name: "secretKey", label: "Secret key", help: "The private key of the pair. Mailjet shows it once, when the key is made." },
    ],
    link: { href: "https://app.mailjet.com/account/apikeys", label: "Open Mailjet API keys" },
    note: "We use them to read your domains, set up receiving and get delivery events. Receiving needs a paid Mailjet plan. Your mail sends from your own Mailjet account.",
  },
  mailersend: {
    kind: "mailersend",
    name: "MailerSend",
    description: "Paste an API token. HelloBox sets up the delivery webhooks and receiving with it.",
    fields: [
      {
        name: "apiKey",
        label: "API token",
        placeholder: "mlsn.xxxxxxxx",
        help: "In MailerSend, open Integrations, then API tokens, and generate a token for All domains with Full access. MailerSend shows it once.",
      },
    ],
    link: { href: "https://app.mailersend.com/api-tokens", label: "Open MailerSend API tokens" },
    note: "We use it to read your domains, set up receiving and get delivery events. Your mail sends from your own MailerSend account.",
  },
  brevo: {
    kind: "brevo",
    name: "Brevo",
    description: "Paste an API key. HelloBox sets up the delivery webhook and receiving with it.",
    fields: [
      {
        name: "apiKey",
        label: "API key",
        placeholder: "xkeysib-xxxxxxxx",
        help: "In Brevo, open SMTP & API, then API Keys, and generate a new API key. An SMTP key won't work here.",
      },
    ],
    link: { href: "https://app.brevo.com/settings/keys/api", label: "Open Brevo API keys" },
    note: "We use it to read your domains, set up receiving and get delivery events. Your mail sends from your own Brevo account.",
  },
  sendgrid: {
    kind: "sendgrid",
    name: "SendGrid",
    description: "Paste an API key with Full Access. HelloBox sets up the delivery webhook and receiving with it.",
    fields: [
      {
        name: "apiKey",
        label: "API key",
        placeholder: "SG.xxxxxxxx",
        help: "In SendGrid, open Settings, then API Keys, and create a key with Full Access. SendGrid shows it once.",
      },
    ],
    link: { href: "https://app.sendgrid.com/settings/api_keys", label: "Open SendGrid API keys" },
    note: "We use it to read your domains, set up receiving and get delivery events. Your mail sends from your own SendGrid account.",
  },
  smtp: {
    kind: "smtp",
    name: "SMTP",
    description: "Any mail server that lets you send with a username and password, such as Google Workspace, Zoho or Fastmail.",
    fields: [
      { name: "host", label: "Server", placeholder: "smtp.example.com", plain: true, help: "Your provider's SMTP server name." },
      {
        name: "port",
        label: "Port",
        plain: true,
        defaultValue: "587",
        help: "587 or 2525 upgrade to a secure connection (STARTTLS), 465 is secure from the start. A server without either isn't used.",
      },
      { name: "username", label: "Username", plain: true, help: "Often your full email address." },
      { name: "password", label: "Password", help: "Use an app password where your provider offers one." },
    ],
    note: "We sign in once to check these before saving. The password is stored encrypted. Mail for your domains is received by HelloBox, and sent mail shows as Sent, never Delivered: SMTP doesn't report delivery.",
  },
};

// One dialog for every provider that connects with pasted keys. `step` replaces the form
// once the keys are in, for providers with a choice to make next.
export function PasteKeyDialog({ provider, open, onOpenChange, onSubmit, step }: {
  provider: PasteKeyProvider;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: Record<string, string>) => Promise<unknown>;
  step?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const values = Object.fromEntries(provider.fields.map((field) => [field.name, String(form.get(field.name) ?? "").trim()]));
    setBusy(true);
    try {
      await onSubmit(values);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Connect {provider.name}</DialogTitle>
          <DialogDescription>{provider.description}</DialogDescription>
        </DialogHeader>
        {step ?? (
          <Form className="contents" onSubmit={submit}>
            <DialogPanel className="space-y-4">
              {provider.fields.map((field, index) => (
                <Field key={field.name}>
                  <FieldLabel>{field.label}</FieldLabel>
                  <Input
                    name={field.name}
                    type={field.plain ? "text" : "password"}
                    required
                    autoComplete="off"
                    spellCheck={false}
                    autoFocus={index === 0}
                    placeholder={field.placeholder}
                    defaultValue={field.defaultValue}
                  />
                  <FieldDescription>{field.help}</FieldDescription>
                </Field>
              ))}
              {provider.link && (
                <a
                  href={provider.link.href}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-sm underline underline-offset-2 hover:text-foreground"
                >
                  {provider.link.label} <ArrowSquareOut className="size-3.5" />
                </a>
              )}
              <p className="text-muted-foreground text-xs">{provider.note}</p>
            </DialogPanel>
            <DialogFooter>
              <Button type="submit" loading={busy}><Key /> Connect</Button>
            </DialogFooter>
          </Form>
        )}
      </DialogPopup>
    </Dialog>
  );
}
