"use client";

import { useEffect } from "react";

// Fired when what a workspace may do changed under the open page (a plan change, in cloud),
// so the screens that show limits and features load them again. The open build never fires it.
const CHANGED_EVENT = "hellobox:entitlements-changed";

export const notifyEntitlementsChanged = () => window.dispatchEvent(new Event(CHANGED_EVENT));

export function useEntitlementsChanged(onChange: () => void) {
  useEffect(() => {
    window.addEventListener(CHANGED_EVENT, onChange);
    return () => window.removeEventListener(CHANGED_EVENT, onChange);
  }, [onChange]);
}
