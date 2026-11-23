import { describe, expect, test } from "bun:test";
import { createVault, normalizeRecoveryCode, open, rewrapVault, seal, unlockVault } from "./vault";

describe("vault", () => {
  test("seals for the public key and opens with the passphrase", async () => {
    const { record } = await createVault("correct horse battery");
    const sealed = await seal({ text: "hello", html: "<p>hello</p>" }, [record]);
    expect(sealed).not.toContain("hello");
    const key = await unlockVault(record.wrappedKey, "correct horse battery");
    expect(await open(sealed, record.keyId, key)).toEqual({ text: "hello", html: "<p>hello</p>" });
  });

  test("a wrong passphrase doesn't unlock", async () => {
    const { record } = await createVault("correct horse battery");
    await expect(unlockVault(record.wrappedKey, "wrong")).rejects.toThrow("doesn't match");
  });

  test("the recovery code sets a new passphrase for the same key", async () => {
    const { record, recoveryCode } = await createVault("forgotten passphrase");
    const sealed = await seal({ text: "old mail", html: null }, [record]);
    const wrappedKey = await rewrapVault(record.recoveryWrappedKey, normalizeRecoveryCode(recoveryCode.toLowerCase()), "new passphrase");
    const key = await unlockVault(wrappedKey, "new passphrase");
    expect((await open(sealed, record.keyId, key)).text).toBe("old mail");
  });

  test("seals for several readers", async () => {
    const a = (await createVault("a passphrase")).record;
    const b = (await createVault("b passphrase")).record;
    const sealed = await seal({ text: "both", html: null }, [a, b]);
    expect((await open(sealed, b.keyId, await unlockVault(b.wrappedKey, "b passphrase"))).text).toBe("both");
  });
});
