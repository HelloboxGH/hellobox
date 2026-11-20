"use client";

import { ArrowSquareOut } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { clientExtensions } from "@/core/client/extensions";
import { ISSUES_URL } from "@/core/links";

const { FeedbackPanel } = clientExtensions;

// Settings → Feedback and the account menu's dialog. A hosted build brings its own form; an
// open instance points to the project's issue tracker.
export function FeedbackContent({ className, onSent }: { className?: string; onSent?: () => void }) {
  if (FeedbackPanel) return <FeedbackPanel className={className} onSent={onSent} />;
  return (
    <div className={className}>
      <p className="mb-3 text-muted-foreground text-sm">Ideas, bugs and questions are tracked in the open.</p>
      <Button render={<a href={ISSUES_URL} target="_blank" rel="noreferrer" />}>Open the issue tracker <ArrowSquareOut /></Button>
    </div>
  );
}

export function FeedbackDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Send feedback</DialogTitle>
          <DialogDescription>Ideas, bugs or questions. It goes straight to the people who build HelloBox.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="pb-6">
          <FeedbackContent />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
