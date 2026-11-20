"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

export function useSearchParam(name: string) {
  return useSyncExternalStore(
    subscribe,
    () => new URLSearchParams(window.location.search).get(name),
    () => null,
  );
}
