"use client";

import { ArrowBendDownLeft, ArrowUp, Copy, Sparkle, X } from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Composer as ComposerRoot, ComposerActionGroup, ComposerActions, ComposerInput, ComposerSubmit,
  type ComposerValue, getComposerText,
} from "@/components/ui/composer";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { call } from "@/core/client/api";
import { notify, notifyError } from "@/core/client/notify";
import { IconAction } from "./icon-action";
import { escapeHtml } from "./types";

// Only sends the open conversation when the user asks, and only ever returns draft text.
export function AiPanel({
  threadId, onClose, onUseDraft,
}: {
  threadId: string | null;
  onClose: () => void;
  onUseDraft: (html: string) => void;
}) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [value, setValue] = useState<ComposerValue>([]);
  const [asked, setAsked] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [share, setShare] = useState(true);

  useEffect(() => {
    call("/ai/settings").then((settings) => setConfigured(settings.configured)).catch(() => setConfigured(false));
  }, []);

  async function submit(prompt: string) {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setAsked(prompt);
    setResult(null);
    setValue([]);
    try {
      const { text } = await call("/ai/draft", { prompt, threadId: share && threadId ? threadId : undefined });
      setResult(text);
    } catch (error) {
      notifyError(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside aria-label="AI assistant" className="motion-rise fixed inset-x-2 bottom-2 z-30 flex max-h-[75dvh] flex-col overflow-hidden rounded-2xl border bg-popover shadow-[0_16px_50px_-12px_rgb(30_30_70/0.3)] sm:inset-x-auto sm:right-6 sm:bottom-6 sm:w-[400px]">
      <header className="flex items-center gap-2 border-b py-2 ps-4 pe-2">
        <Sparkle weight="fill" className="size-4 text-brand" />
        <h2 className="flex-1 font-semibold text-foreground text-sm">AI assistant</h2>
        <IconAction label="Close" onClick={onClose}><X /></IconAction>
      </header>
      {configured === false ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><Sparkle /></EmptyMedia>
            <EmptyTitle>Bring your own AI</EmptyTitle>
            <EmptyDescription>Add your provider&apos;s key. It stays encrypted, and the assistant only reads what you share.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent><Button render={<Link href="/settings?tab=ai" />}>Add a provider</Button></EmptyContent>
        </Empty>
      ) : (
        <>
          <ScrollArea className="min-h-32 flex-1">
            <div className="space-y-3 p-4">
              {!asked && <p className="text-muted-foreground text-sm">Ask for a reply or a new draft. You review everything before it goes out.</p>}
              {asked && <p className="ms-auto w-fit max-w-[85%] rounded-2xl rounded-ee-sm bg-brand-soft px-3 py-2 text-brand-foreground text-sm">{asked}</p>}
              {busy && (
                <div className="space-y-2">
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-5/6" />
                  <Skeleton className="h-3 w-3/5" />
                </div>
              )}
              {result && (
                <>
                  <p className="whitespace-pre-wrap text-foreground text-sm leading-relaxed">{result}</p>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => onUseDraft(escapeHtml(result).replace(/\n/g, "<br>"))}>
                      <ArrowBendDownLeft /> Use as draft
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={async () => {
                        await navigator.clipboard.writeText(result);
                        notify("Copied");
                      }}
                    >
                      <Copy /> Copy
                    </Button>
                  </div>
                  <p className="text-muted-foreground text-xs">Nothing goes out until you press Send yourself.</p>
                </>
              )}
            </div>
          </ScrollArea>
          <div className="space-y-2 border-t p-3">
            {threadId && (
              <Label className="flex items-center justify-between gap-2 font-normal text-muted-foreground text-xs">
                Share this conversation with your AI provider
                <Switch checked={share} onCheckedChange={setShare} />
              </Label>
            )}
            <ComposerRoot layout="adaptive" value={value} onValueChange={setValue} onSubmit={(draft) => submit(getComposerText(draft))}>
              <ComposerInput aria-label="Your request" className="px-2" placeholder="Write a warm reply…" />
              <ComposerActions>
                <ComposerActionGroup align="end">
                  <ComposerSubmit render={<Button aria-label="Ask" className="rounded-full" size="icon" disabled={busy}><ArrowUp weight="bold" /></Button>} />
                </ComposerActionGroup>
              </ComposerActions>
            </ComposerRoot>
          </div>
        </>
      )}
    </aside>
  );
}
