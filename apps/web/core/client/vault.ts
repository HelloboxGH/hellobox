"use client";

import { normalizeRecoveryCode, open, rewrapVault, unlockVault, type SealedContent } from "@hellobox/mail/vault";
import { useEffect, useSyncExternalStore } from "react";
import { call } from "./api";

// The unlocked private key lives in IndexedDB as a non-extractable CryptoKey: pages on
// this device can use it to open mail, but nothing can read the key's bytes back out,
// including script on this page. Locking deletes it.

const DB_NAME = "hellobox-vault";
const STORE = "keys";

type Status = Awaited<ReturnType<typeof fetchStatus>>;
type State = { status: Status | null; key: CryptoKey | null; loading: boolean };

const fetchStatus = () => call("/account/vault");

let state: State = { status: null, key: null, loading: false };
const listeners = new Set<() => void>();
const set = (next: Partial<State>) => {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
};

function idb<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(STORE, mode);
      const op = run(tx.objectStore(STORE));
      tx.oncomplete = () => {
        db.close();
        resolve(op.result);
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

async function storedKey(keyId: string) {
  try {
    const key = await idb<CryptoKey | undefined>("readonly", (store) => store.get(keyId));
    return key ?? null;
  } catch {
    // Private windows and blocked storage: the key lasts as long as this page.
    return null;
  }
}

async function storeKey(keyId: string, key: CryptoKey) {
  try {
    await idb("readwrite", (store) => store.put(key, keyId));
  } catch {
    // Not kept on this device; the passphrase is asked again next visit.
  }
}

export async function refreshVault() {
  set({ loading: true });
  try {
    const status = await fetchStatus();
    const key = status.vault ? (state.key ?? (await storedKey(status.vault.keyId))) : null;
    set({ status, key, loading: false });
    return status;
  } catch (error) {
    set({ loading: false });
    throw error;
  }
}

async function remember(keyId: string, key: CryptoKey) {
  await storeKey(keyId, key);
  set({ key });
}

export async function unlockWithPassphrase(passphrase: string) {
  const status = state.status ?? (await refreshVault());
  if (!status.vault) throw new Error("Encryption isn't set up");
  await remember(status.vault.keyId, await unlockVault(status.vault.wrappedKey, passphrase));
}

// Forgot the passphrase: the recovery code unlocks the same key and sets a new one.
export async function recoverWithCode(code: string, newPassphrase: string) {
  const status = state.status ?? (await refreshVault());
  if (!status.vault) throw new Error("Encryption isn't set up");
  const secret = normalizeRecoveryCode(code);
  const key = await unlockVault(status.vault.recoveryWrappedKey, secret);
  const wrappedKey = await rewrapVault(status.vault.recoveryWrappedKey, secret, newPassphrase);
  await call("/account/vault/passphrase", { keyId: status.vault.keyId, wrappedKey });
  await remember(status.vault.keyId, key);
  await refreshVault();
}

export async function changePassphrase(current: string, next: string) {
  const status = state.status ?? (await refreshVault());
  if (!status.vault) throw new Error("Encryption isn't set up");
  const wrappedKey = await rewrapVault(status.vault.wrappedKey, current, next);
  await call("/account/vault/passphrase", { keyId: status.vault.keyId, wrappedKey });
  await refreshVault();
}

export async function lockVault() {
  try {
    await idb("readwrite", (store) => store.clear());
  } catch {
    // Nothing stored.
  }
  set({ key: null });
}

export async function openSealed(sealed: string): Promise<SealedContent | null> {
  const status = state.status ?? (await refreshVault().catch(() => null));
  if (!status?.vault || !state.key) return null;
  return open(sealed, status.vault.keyId, state.key);
}

export function useVault() {
  const snapshot = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => state,
  );
  useEffect(() => {
    if (!state.status && !state.loading) refreshVault().catch(() => undefined);
  }, []);
  return snapshot;
}
