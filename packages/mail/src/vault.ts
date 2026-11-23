// Encrypt-on-arrival for mailboxes. Runs the same in the server and the browser: only
// WebCrypto and a pure JS Argon2id, no Node APIs.
//
// The server holds a person's public key and their private key wrapped twice: once with a
// key from their passphrase, once with a key from a recovery code. It never sees either, so
// it can seal mail as it arrives but can't open what it stored. Each message gets its own
// AES-GCM key, sealed to every reader's X25519 key, so a shared mailbox later only means
// more entries in `keys`.

import { argon2idAsync } from "@noble/hashes/argon2";

export type KdfParams = { name: "argon2id"; m: number; t: number; p: number; salt: string };
export type WrappedKey = { kdf: KdfParams; iv: string; data: string };

export type VaultRecord = {
  keyId: string;
  publicKey: string; // raw X25519, base64
  wrappedKey: WrappedKey;
  recoveryWrappedKey: WrappedKey;
};

export type SealedEnvelope = {
  v: 1;
  keys: { kid: string; epk: string; iv: string; key: string }[];
  iv: string;
  data: string;
};

export type SealedContent = { text: string | null; html: string | null };

// OWASP's Argon2id baseline. Stored with each wrapped key, so it can be raised later.
const DEFAULT_KDF = { m: 19_456, t: 2, p: 1 };
const INFO = new TextEncoder().encode("hellobox-vault-v1");
const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789"; // no 0/O, 1/I/L, U

const subtle = () => globalThis.crypto.subtle;

export const b64 = (bytes: ArrayBuffer | Uint8Array) => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (const byte of view) out += String.fromCharCode(byte);
  return btoa(out);
};

export const unb64 = (value: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));

const random = (length: number) => globalThis.crypto.getRandomValues(new Uint8Array(length));

async function passphraseKey(secret: string, kdf: KdfParams) {
  const bits = new Uint8Array(await argon2idAsync(new TextEncoder().encode(secret), unb64(kdf.salt), {
    m: kdf.m, t: kdf.t, p: kdf.p, dkLen: 32,
  }));
  return subtle().importKey("raw", bits, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function wrap(pkcs8: ArrayBuffer, secret: string): Promise<WrappedKey> {
  const kdf: KdfParams = { name: "argon2id", ...DEFAULT_KDF, salt: b64(random(16)) };
  const iv = random(12);
  const data = await subtle().encrypt({ name: "AES-GCM", iv }, await passphraseKey(secret, kdf), pkcs8);
  return { kdf, iv: b64(iv), data: b64(data) };
}

// Normalized so spaces, dashes and case don't matter when someone types it back.
export const normalizeRecoveryCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

function recoveryCode() {
  // 24 characters from 30 symbols: about 118 bits.
  const chars = [...random(24)].map((byte) => RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length]);
  return chars.join("").match(/.{4}/g)!.join("-");
}

async function keyIdOf(publicRaw: ArrayBuffer) {
  const digest = await subtle().digest("SHA-256", publicRaw);
  return b64(digest.slice(0, 12));
}

// Made on the person's device. The record goes to the server; the code is shown once.
export async function createVault(passphrase: string) {
  const pair = (await subtle().generateKey({ name: "X25519" }, true, ["deriveBits"])) as unknown as CryptoKeyPair;
  const publicRaw = await subtle().exportKey("raw", pair.publicKey);
  const pkcs8 = await subtle().exportKey("pkcs8", pair.privateKey);
  const code = recoveryCode();
  const record: VaultRecord = {
    keyId: await keyIdOf(publicRaw),
    publicKey: b64(publicRaw),
    wrappedKey: await wrap(pkcs8, passphrase),
    recoveryWrappedKey: await wrap(pkcs8, normalizeRecoveryCode(code)),
  };
  return { record, recoveryCode: code };
}

async function unwrapPkcs8(wrapped: WrappedKey, secret: string) {
  try {
    return await subtle().decrypt(
      { name: "AES-GCM", iv: unb64(wrapped.iv) },
      await passphraseKey(secret, wrapped.kdf),
      unb64(wrapped.data),
    );
  } catch {
    throw new Error("That passphrase or recovery code doesn't match");
  }
}

// The private key as a key that can't be exported again, for keeping on this device.
export async function unlockVault(wrapped: WrappedKey, secret: string) {
  const pkcs8 = await unwrapPkcs8(wrapped, secret);
  return subtle().importKey("pkcs8", pkcs8, { name: "X25519" }, false, ["deriveBits"]);
}

// A new passphrase after recovering with the code (or to change it). The key pair stays the
// same, so every stored message still opens.
export async function rewrapVault(wrapped: WrappedKey, secret: string, newPassphrase: string) {
  return wrap(await unwrapPkcs8(wrapped, secret), newPassphrase);
}

async function kek(shared: ArrayBuffer, salt: Uint8Array<ArrayBuffer>, usage: ("encrypt" | "decrypt")[]) {
  const base = await subtle().importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return subtle().deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: INFO },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    usage,
  );
}

export async function seal(
  content: SealedContent,
  recipients: { keyId: string; publicKey: string }[],
): Promise<string> {
  if (!recipients.length) throw new Error("Nobody to seal this for");
  const contentKey = random(32);
  const iv = random(12);
  const aes = await subtle().importKey("raw", contentKey, "AES-GCM", false, ["encrypt"]);
  const data = await subtle().encrypt({ name: "AES-GCM", iv }, aes, new TextEncoder().encode(JSON.stringify(content)));
  const keys = await Promise.all(
    recipients.map(async (recipient) => {
      const eph = (await subtle().generateKey({ name: "X25519" }, true, ["deriveBits"])) as unknown as CryptoKeyPair;
      const theirs = await subtle().importKey("raw", unb64(recipient.publicKey), { name: "X25519" }, false, []);
      const shared = await subtle().deriveBits({ name: "X25519", public: theirs }, eph.privateKey, 256);
      const epk = new Uint8Array(await subtle().exportKey("raw", eph.publicKey));
      const wrapIv = random(12);
      const wrapped = await subtle().encrypt({ name: "AES-GCM", iv: wrapIv }, await kek(shared, epk, ["encrypt"]), contentKey);
      return { kid: recipient.keyId, epk: b64(epk), iv: b64(wrapIv), key: b64(wrapped) };
    }),
  );
  const envelope: SealedEnvelope = { v: 1, keys, iv: b64(iv), data: b64(data) };
  return JSON.stringify(envelope);
}

export async function open(sealed: string, keyId: string, privateKey: CryptoKey): Promise<SealedContent> {
  const envelope = JSON.parse(sealed) as SealedEnvelope;
  const entry = envelope.keys.find((k) => k.kid === keyId);
  if (!entry) throw new Error("This message was sealed for a different key");
  const epk = unb64(entry.epk);
  const theirs = await subtle().importKey("raw", epk, { name: "X25519" }, false, []);
  const shared = await subtle().deriveBits({ name: "X25519", public: theirs }, privateKey, 256);
  const contentKey = await subtle().decrypt(
    { name: "AES-GCM", iv: unb64(entry.iv) },
    await kek(shared, epk, ["decrypt"]),
    unb64(entry.key),
  );
  const aes = await subtle().importKey("raw", contentKey, "AES-GCM", false, ["decrypt"]);
  const plain = await subtle().decrypt({ name: "AES-GCM", iv: unb64(envelope.iv) }, aes, unb64(envelope.data));
  return JSON.parse(new TextDecoder().decode(plain)) as SealedContent;
}
