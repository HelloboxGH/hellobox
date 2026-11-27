"use client";

import { ShieldCheck, Warning } from "@phosphor-icons/react";
import { Callout } from "@/components/callout";
import { Badge } from "@/components/ui/badge";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";

// Why bounces are off unless someone needs them. Shown in onboarding and Settings, so the
// choice is made knowing what it costs.
export const BOUNCE_RISKS = [
  "Every bounce is an email sent through your provider, paid for from your sending credits.",
  "Anyone can provoke them by writing to made-up addresses at your domain. HelloBox caps bounces at 50 a day per workspace, but each one still costs you.",
  "They tell spammers which addresses at your domain don't exist, which helps them find the ones that do.",
  "A bounce that reaches someone who never wrote to you, because their address was forged, can hurt your domain's reputation. We only answer verified senders, but no check is perfect.",
];

const OPTIONS = [
  {
    value: "quiet",
    title: "Stay quiet",
    badge: "Recommended",
    body: "Mail to an address with no mailbox goes to Spam and is deleted after 24 hours. The sender isn't told. Your credits and reputation are untouched.",
  },
  {
    value: "bounce",
    title: "Send a bounce",
    body: "The sender gets an “address doesn't exist” email from your domain. Only worth it if people often mistype your addresses and need to know.",
  },
] as const;

// refusesAtDelivery: some domains receive with HelloBox's mail server, which turns down mail
// for unknown addresses while the sender's server is still delivering it, instead of mailing
// a bounce afterwards.
export function BounceChoice({ enabled, onChange, disabled, refusesAtDelivery }: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  disabled?: boolean;
  refusesAtDelivery?: boolean;
}) {
  return (
    <div className="space-y-3">
      <RadioGroup
        aria-label="Mail to addresses that don't exist"
        value={enabled ? "bounce" : "quiet"}
        onValueChange={(value) => onChange(value === "bounce")}
        disabled={disabled}
        className="grid gap-2 sm:grid-cols-2"
      >
        {OPTIONS.map((option) => {
          const checked = (option.value === "bounce") === enabled;
          return (
            <label
              key={option.value}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors has-data-disabled:cursor-not-allowed has-data-disabled:opacity-64",
                checked ? "border-brand bg-brand-soft" : "bg-background hover:bg-accent/50",
              )}
            >
              <Radio value={option.value} className="mt-0.5" />
              <span className="min-w-0 space-y-1">
                <span className="flex flex-wrap items-center gap-1.5 font-medium text-foreground text-sm">
                  {option.title}
                  {"badge" in option && <Badge variant="success" size="sm">{option.badge}</Badge>}
                </span>
                <span className="block text-muted-foreground text-xs leading-relaxed">{option.body}</span>
              </span>
            </label>
          );
        })}
      </RadioGroup>
      <Callout
        tone={enabled ? "warning" : "neutral"}
        icon={enabled ? <Warning weight="fill" /> : <ShieldCheck />}
        title={enabled ? "Bounces are on, which exposes you to:" : "Why we recommend staying quiet"}
      >
        <ul className="mt-1 space-y-1">
          {BOUNCE_RISKS.map((risk) => (
            <li key={risk} className="flex gap-2">
              <span aria-hidden className="mt-[0.45rem] size-1 shrink-0 rounded-full bg-current opacity-60" />
              <span>{risk}</span>
            </li>
          ))}
        </ul>
      </Callout>
      {refusesAtDelivery && (
        <p className="text-muted-foreground text-xs leading-relaxed">
          Domains received with HelloBox work differently: with bounces on, the mail server refuses mail for an address with no mailbox
          while the sender&apos;s server is still delivering it. The sender&apos;s own server tells them, so nothing is sent from your domain
          and no credits are used. It still shows which addresses exist, so a sender that keeps naming unknown ones is cut off.
        </p>
      )}
    </div>
  );
}
