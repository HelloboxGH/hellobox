"use client";

import { useSyncExternalStore } from "react";
import { call } from "./api";

// Uploads of import files. They live outside React so they keep going when the dialog
// closes or onboarding moves to another step; leaving the page stops them, so the page
// asks first while one is running.

export type ImportTarget = { mailboxId: string } | { address: string };

export type ActiveUpload = {
  key: string;
  filename: string;
  size: number;
  sent: number;
  status: "uploading" | "done" | "failed";
  error?: string;
  importId?: string;
};

const PARALLEL = 3;
const BATCH = 50;

let uploads: ActiveUpload[] = [];
const listeners = new Set<() => void>();
const controllers = new Map<string, AbortController>();

function set(key: string, patch: Partial<ActiveUpload>) {
  uploads = uploads.map((upload) => (upload.key === key ? { ...upload, ...patch } : upload));
  for (const listener of listeners) listener();
  guardUnload();
}

const uploading = () => uploads.some((upload) => upload.status === "uploading");

function onBeforeUnload(event: BeforeUnloadEvent) {
  event.preventDefault();
}

function guardUnload() {
  if (typeof window === "undefined") return;
  window.removeEventListener("beforeunload", onBeforeUnload);
  if (uploading()) window.addEventListener("beforeunload", onBeforeUnload);
}

async function putPart(url: string, body: Blob, signal: AbortSignal) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { method: "PUT", body, signal });
      const etag = res.headers.get("etag");
      if (res.ok && etag) return etag;
      throw new Error(`Part upload failed (${res.status})`);
    } catch (error) {
      if (signal.aborted || attempt >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
}

async function upload(key: string, file: File, target: ImportTarget, signal: AbortSignal) {
  const { id, partSize, parts } = await call("/imports/start", { filename: file.name, size: file.size, ...target });
  set(key, { importId: id });
  const etags: { partNumber: number; etag: string }[] = [];
  let next = 1;
  let urls = new Map<number, string>();
  const urlFor = async (partNumber: number) => {
    if (!urls.has(partNumber)) {
      const wanted = Array.from({ length: Math.min(BATCH, parts - partNumber + 1) }, (_, i) => partNumber + i);
      const result = await call("/imports/parts", { id, partNumbers: wanted });
      urls = new Map(result.urls.map((entry) => [entry.partNumber, entry.url]));
    }
    return urls.get(partNumber)!;
  };
  let sent = 0;
  const worker = async () => {
    while (next <= parts) {
      const partNumber = next++;
      const body = file.slice((partNumber - 1) * partSize, partNumber * partSize);
      const etag = await putPart(await urlFor(partNumber), body, signal);
      etags.push({ partNumber, etag });
      sent += body.size;
      set(key, { sent });
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, parts) }, worker));
  await call("/imports/complete", { id, parts: etags.sort((a, b) => a.partNumber - b.partNumber) });
}

// Starts each file's upload in turn. Returns once they're all uploaded or failed; the
// importing itself happens on the server after that.
export async function startImports(files: File[], target: ImportTarget) {
  const added = files.map((file) => ({
    file,
    entry: { key: crypto.randomUUID(), filename: file.name, size: file.size, sent: 0, status: "uploading" as const },
  }));
  uploads = [...uploads, ...added.map((item) => item.entry)];
  guardUnload();
  for (const listener of listeners) listener();
  // One after another: the first file makes the mailbox if the address is new, and the
  // rest find it there.
  for (const { file, entry } of added) {
    const controller = new AbortController();
    controllers.set(entry.key, controller);
    try {
      await upload(entry.key, file, target, controller.signal);
      set(entry.key, { status: "done", sent: file.size });
    } catch (error) {
      set(entry.key, { status: "failed", error: error instanceof Error ? error.message : "The upload failed" });
    } finally {
      controllers.delete(entry.key);
    }
  }
}

export async function cancelUpload(key: string) {
  controllers.get(key)?.abort();
  const entry = uploads.find((item) => item.key === key);
  if (entry?.importId) await call("/imports/cancel", { id: entry.importId }).catch(() => undefined);
  uploads = uploads.filter((item) => item.key !== key);
  for (const listener of listeners) listener();
  guardUnload();
}

export function clearFinishedUploads() {
  uploads = uploads.filter((item) => item.status === "uploading");
  for (const listener of listeners) listener();
}

export const isUploading = uploading;

export function useImportUploads() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => uploads,
    () => uploads,
  );
}
