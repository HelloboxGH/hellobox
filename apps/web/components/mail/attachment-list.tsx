"use client";

import { DownloadSimple } from "@phosphor-icons/react";
import { createElement, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { fileIcon } from "./file-icon";
import { formatBytes } from "./types";

interface File {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

const href = (file: File) => `/api/attachments/${file.id}`;

function Download({ file }: { file: File }) {
  return (
    <Button variant="outline" size="sm" render={<a href={href(file)} />} className="max-w-64">
      {createElement(fileIcon(file.filename, file.contentType))}
      <span className="truncate">{file.filename}</span>
      <span className="shrink-0 text-muted-foreground text-xs">{formatBytes(file.size)}</span>
      <DownloadSimple />
    </Button>
  );
}

// Asked of the server, which looks at the file itself. What isn't an image after all, or is
// too big to show, becomes a download like any other file.
function ImagePreview({ file }: { file: File }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <Download file={file} />;
  const src = `${href(file)}/preview`;
  return (
    <Dialog>
      <DialogTrigger
        render={
          <button
            type="button"
            aria-label={`View ${file.filename}`}
            className="flex h-32 min-w-20 max-w-64 items-center justify-center overflow-hidden rounded-lg border bg-muted/40 outline-none hover:border-ring focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      >
        {/* Never through Next's optimizer: our server doesn't decode what strangers send. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="size-full object-cover" />
      </DialogTrigger>
      <DialogPopup className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="truncate pe-8 text-base">{file.filename}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="flex justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={file.filename} referrerPolicy="no-referrer" className="max-h-[70vh] max-w-full rounded-md object-contain" />
        </DialogPanel>
        <DialogFooter>
          <Download file={file} />
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

const claimsImage = (file: File) => /^image\/(png|jpe?g|gif|webp)$/i.test(file.contentType);

/** A message's files. Images show themselves, except in Spam. */
export function AttachmentList({ files, previews }: { files: File[]; previews: boolean }) {
  const images = previews ? files.filter(claimsImage) : [];
  const others = files.filter((file) => !images.includes(file));
  return (
    <div className="space-y-2">
      {images.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {images.map((file) => <li key={file.id}><ImagePreview file={file} /></li>)}
        </ul>
      )}
      {others.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {others.map((file) => <li key={file.id}><Download file={file} /></li>)}
        </ul>
      )}
    </div>
  );
}
