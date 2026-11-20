"use client";

import { Camera } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { SenderAvatar } from "@/components/mail/sender-avatar";
import { Button } from "@/components/ui/button";
import { removeAvatar, uploadAvatar } from "@/core/client/avatar";
import { notify, notifyError } from "@/core/client/notify";

export function ProfilePhoto({
  name,
  email,
  image,
  onChanged,
}: {
  name: string;
  email: string;
  image: string | null;
  onChanged: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  async function change(work: () => Promise<void>, success: string) {
    setBusy(true);
    try {
      await work();
      notify(success);
      onChanged();
    } catch (error) {
      notifyError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-3">
      <SenderAvatar name={name || email} src={image} className="size-14" />
      <div className="min-w-40 flex-1">
        <p className="truncate text-foreground text-sm">{name || "Your name"}</p>
        <p className="truncate text-muted-foreground text-sm">{email}</p>
      </div>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        aria-label="Profile photo"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void change(() => uploadAvatar(file), "Photo updated");
        }}
      />
      <div className="flex gap-2">
        <Button type="button" size="sm" variant="outline" loading={busy} onClick={() => input.current?.click()}>
          <Camera /> {image ? "Change photo" : "Upload photo"}
        </Button>
        {image && (
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => change(removeAvatar, "Photo removed")}>
            Remove
          </Button>
        )}
      </div>
    </div>
  );
}
