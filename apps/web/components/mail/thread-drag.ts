"use client";

import { type DragEvent, useRef, useState, useSyncExternalStore } from "react";
import type { ThreadSummary } from "@/core/client/api";
import { notify } from "@/core/client/notify";
import type { ThreadAction } from "./thread-actions";

/**
 * Conversations being dragged from the list onto the sidebar. The list owns the
 * actions (optimistic rows, Undo), so it hands over its `run` with the drag.
 */
type ThreadDrag = {
  targets: ThreadSummary[];
  run: (action: ThreadAction, targets: ThreadSummary[]) => void;
};

const MIME = "application/x-hellobox-threads";
let current: ThreadDrag | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

export function useThreadDrag() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => null,
  );
}

const plural = (n: number) => (n === 1 ? "1 conversation" : `${n} conversations`);

export function startThreadDrag(event: DragEvent, drag: ThreadDrag) {
  current = drag;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData(MIME, drag.targets.map((thread) => thread.id).join(","));
  event.dataTransfer.setData("text/plain", drag.targets.map((thread) => thread.subject || "(no subject)").join("\n"));

  // A small chip under the pointer instead of a ghost of the whole row.
  const ghost = document.createElement("div");
  ghost.textContent = drag.targets.length === 1 ? drag.targets[0].subject || "(no subject)" : plural(drag.targets.length);
  Object.assign(ghost.style, {
    position: "fixed", top: "-1000px", left: "-1000px", maxWidth: "240px", padding: "6px 10px",
    borderRadius: "8px", font: "500 13px/1.3 var(--font-sans, system-ui)", whiteSpace: "nowrap",
    overflow: "hidden", textOverflow: "ellipsis", background: "var(--primary)", color: "var(--primary-foreground)",
    boxShadow: "0 4px 12px rgb(0 0 0 / 0.15)",
  });
  document.body.appendChild(ghost);
  event.dataTransfer.setDragImage(ghost, 12, 12);
  setTimeout(() => ghost.remove(), 0);
  // Defer so the browser grabs the drag image before anything re-renders.
  setTimeout(emit, 0);
}

export function endThreadDrag() {
  current = null;
  emit();
}

/**
 * Makes a sidebar item take dropped conversations. `actionFor` returns null where the
 * drop would do nothing (Archive while they're all archived), and the item then refuses it.
 */
export function useDropTarget(
  actionFor: (targets: ThreadSummary[]) => ThreadAction | null,
  done?: (count: string) => string,
) {
  const drag = useThreadDrag();
  // Tied to the drag, so a drag that ended elsewhere never leaves an item lit.
  const [overFor, setOverFor] = useState<ThreadDrag | null>(null);
  const depth = useRef(0);
  const action = drag ? actionFor(drag.targets) : null;
  if (!drag || !action) return { active: false, props: {} };

  return {
    active: true,
    props: {
      "data-drop-over": overFor === drag ? "" : undefined,
      onDragEnter: (event: DragEvent) => {
        event.preventDefault();
        if (overFor !== drag) depth.current = 0;
        depth.current += 1;
        setOverFor(drag);
      },
      onDragOver: (event: DragEvent) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      },
      onDragLeave: () => {
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setOverFor(null);
      },
      onDrop: (event: DragEvent) => {
        event.preventDefault();
        depth.current = 0;
        setOverFor(null);
        const { targets, run } = drag;
        endThreadDrag();
        run(action, targets);
        // Moves already confirm with an Undo toast; these change nothing visible in the list.
        if (done) notify(done(targets.length === 1 ? "Conversation" : plural(targets.length)));
      },
    },
  };
}
