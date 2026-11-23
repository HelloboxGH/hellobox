"use client";

import { LockSimple, LockSimpleOpen, ShieldCheck, Warning } from "@phosphor-icons/react";
import { createVault } from "@hellobox/mail/vault";
import Link from "next/link";
import { type FormEvent, useRef, useState } from "react";
import { Callout } from "@/components/callout";
import { PasswordInput } from "@/components/password-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { call } from "@/core/client/api";
import {
  changePassphrase, lockVault, recoverWithCode, refreshVault, unlockWithPassphrase, useVault,
} from "@/core/client/vault";
import { Section, useRunning } from "./shared";

const MIN_PASSPHRASE = 12;

// Everything that runs on the server and needs the body of a message. It can't read
// encrypted mail, so these stop working for it.
const LOST_FEATURES = [
  { name: "Search", detail: "finds encrypted mail by subject and sender only, not by what's in it." },
  { name: "AI", detail: "can't summarize, draft replies to or answer questions about encrypted mail." },
  { name: "Agents and the MCP server", detail: "see the subject and sender, but not the message." },
  { name: "Notifications", detail: "show who wrote and the subject, without a preview." },
  { name: "Conversation list", detail: "shows no preview line under the subject." },
  { name: "Other devices", detail: "need your passphrase before encrypted mail opens on them." },
] as const;

export function FeatureWarning({ title = "Some features stop working for encrypted mail" }: { title?: string }) {
  return (
    <Callout tone="warning" icon={<Warning />} title={title}>
      <p className="mb-1.5 text-sm">HelloBox can&apos;t read encrypted mail, so the features that need to read it don&apos;t work on it:</p>
      <ul className="list-disc space-y-0.5 ps-5 text-sm">
        {LOST_FEATURES.map((feature) => (
          <li key={feature.name}><strong className="font-medium text-foreground">{feature.name}</strong> {feature.detail}</li>
        ))}
      </ul>
      <p className="mt-1.5 text-muted-foreground text-xs">Mail that isn&apos;t encrypted keeps every feature. Turning encryption off only affects new mail.</p>
    </Callout>
  );
}

// Shown in place of a sealed message's body until this device has the key.
export function UnlockVault() {
  const vault = useVault();
  const [running, start] = useRunning();
  if (!vault.status?.vault) {
    return (
      <Callout tone="neutral" icon={<LockSimple />}>
        This message is encrypted, and the keys that open it were deleted. It can&apos;t be read any more.
      </Callout>
    );
  }
  return (
    <Callout tone="neutral" icon={<LockSimple />} title="This message is encrypted">
      <Form
        className="mt-2 flex flex-wrap items-start gap-2"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const passphrase = String(new FormData(event.currentTarget).get("passphrase"));
          start(() => unlockWithPassphrase(passphrase), "Unlocked on this device");
        }}
      >
        <div className="min-w-48 flex-1">
          <PasswordInput name="passphrase" placeholder="Encryption passphrase" required autoComplete="off" aria-label="Encryption passphrase" />
        </div>
        <Button type="submit" variant="outline" loading={running}>Unlock</Button>
      </Form>
      <p className="mt-2 text-muted-foreground text-xs">
        Forgot it? <Link className="underline" href="/settings?tab=encryption">Use your recovery code</Link>.
      </p>
    </Callout>
  );
}

export function EncryptionTab() {
  const vault = useVault();
  if (!vault.status) return <Skeleton className="h-64 w-full rounded-2xl" />;
  return (
    <div className="space-y-4">
      <Section
        title="Mailbox encryption"
        description="Encrypt your personal mailboxes so that HelloBox stores only ciphertext. Mail is encrypted the moment it arrives, with a key that only you can unlock."
      >
        <ul className="list-disc space-y-1 ps-5 text-muted-foreground text-sm">
          <li>Protects stored mail from a database leak, a stolen backup, anyone with access to the servers later, and requests to hand over old mail.</li>
          <li>It isn&apos;t end-to-end: mail reaches us unencrypted from your email provider, which may keep its own copy. A server compromised at the moment mail arrives could read it.</li>
          <li>Subjects, senders and dates stay readable, so your inbox can be listed and sorted. Attachments aren&apos;t encrypted yet.</li>
          <li><strong className="text-foreground">If you lose both your passphrase and your recovery code, your encrypted mail is gone.</strong> Nobody, us included, can get it back.</li>
        </ul>
        <FeatureWarning />
      </Section>
      {vault.status.vault ? <ManageVault /> : <CreateVault />}
    </div>
  );
}

function CreateVault() {
  const [running, start] = useRunning();
  const [pending, setPending] = useState<Awaited<ReturnType<typeof createVault>> | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passphraseRef = useRef("");
  return (
    <Section title="Set up encryption" description="Choose a passphrase that's different from your sign-in password. Resetting your password doesn't reset this, so a reset can never cost you your mail.">
      <Form
        className="space-y-3"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const passphrase = String(form.get("passphrase"));
          if (passphrase !== String(form.get("confirm"))) return setError("The passphrases don't match");
          setError(null);
          passphraseRef.current = passphrase;
          // Made on this device. Nothing is sent until the recovery code is saved.
          start(async () => setPending(await createVault(passphrase)));
        }}
      >
        <Field>
          <FieldLabel>Passphrase</FieldLabel>
          <PasswordInput name="passphrase" required minLength={MIN_PASSPHRASE} autoComplete="new-password" />
          <FieldDescription>At least {MIN_PASSPHRASE} characters. A few unrelated words work well.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel>Passphrase again</FieldLabel>
          <PasswordInput name="confirm" required minLength={MIN_PASSPHRASE} autoComplete="new-password" />
          {error && <FieldDescription className="text-destructive-foreground">{error}</FieldDescription>}
        </Field>
        <Button type="submit" loading={running}><ShieldCheck /> Create keys</Button>
      </Form>

      <Dialog open={pending !== null} onOpenChange={(open) => { if (!open) { setPending(null); setSaved(false); } }}>
        <DialogPopup className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Save your recovery code</DialogTitle>
            <DialogDescription>
              If you forget your passphrase, this code is the only way back into your encrypted mail. It&apos;s shown once. Keep it in a password manager or on paper.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <p className="select-all rounded-lg border bg-muted p-3 text-center font-mono text-sm tracking-wider">{pending?.recoveryCode}</p>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => navigator.clipboard.writeText(pending?.recoveryCode ?? "")}>Copy</Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const blob = new Blob([`HelloBox encryption recovery code\n\n${pending?.recoveryCode}\n`], { type: "text/plain" });
                  const link = document.createElement("a");
                  link.href = URL.createObjectURL(blob);
                  link.download = "hellobox-recovery-code.txt";
                  link.click();
                  URL.revokeObjectURL(link.href);
                }}
              >
                Download
              </Button>
            </div>
            <Label className="flex items-start gap-2 font-normal">
              <Checkbox checked={saved} onCheckedChange={(checked) => setSaved(checked === true)} />
              I saved it. I understand that without the passphrase or this code, my encrypted mail can&apos;t be recovered.
            </Label>
          </DialogPanel>
          <DialogFooter>
            <Button
              disabled={!saved}
              loading={running}
              onClick={() => start(async () => {
                if (!pending) return;
                await call("/account/vault/create", pending.record);
                setPending(null);
                await refreshVault();
                // The passphrase was just typed, so this device starts unlocked.
                await unlockWithPassphrase(passphraseRef.current);
                passphraseRef.current = "";
              }, "Encryption is set up. Turn it on for a mailbox below.")}
            >
              Finish setup
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </Section>
  );
}

function ManageVault() {
  const vault = useVault();
  const [running, start] = useRunning();
  const status = vault.status!;
  const unlocked = Boolean(vault.key);
  // Turning encryption on waits for the warning to be read and accepted.
  const [confirming, setConfirming] = useState<{ id: string; address: string } | null>(null);
  const [understood, setUnderstood] = useState(false);
  const setEncrypted = (mailbox: { id: string; address: string }, encrypted: boolean) =>
    start(async () => {
      await call("/account/vault/mailbox", { id: mailbox.id, encrypted });
      await refreshVault();
      setConfirming(null);
    }, encrypted ? `New mail to ${mailbox.address} is encrypted` : `New mail to ${mailbox.address} is stored unencrypted`);
  return (
    <>
      <Section title="This device">
        <div className="flex flex-wrap items-center gap-3">
          {unlocked
            ? <Badge variant="success"><LockSimpleOpen /> Unlocked</Badge>
            : <Badge variant="outline"><LockSimple /> Locked</Badge>}
          <p className="flex-1 text-muted-foreground text-sm">
            {unlocked
              ? "Encrypted mail opens here without asking. Lock it on a shared or borrowed computer."
              : "Encrypted mail asks for your passphrase before it opens here."}
          </p>
          {unlocked && <Button variant="outline" size="sm" onClick={() => lockVault()}>Lock this device</Button>}
        </div>
        {!unlocked && (
          <Form
            className="flex flex-wrap gap-2"
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              const passphrase = String(new FormData(event.currentTarget).get("passphrase"));
              start(() => unlockWithPassphrase(passphrase), "Unlocked on this device");
            }}
          >
            <div className="min-w-48 flex-1"><PasswordInput name="passphrase" placeholder="Encryption passphrase" required aria-label="Encryption passphrase" /></div>
            <Button type="submit" variant="outline" loading={running}>Unlock</Button>
          </Form>
        )}
      </Section>

      <Section title="Encrypted mailboxes" description="Mail that arrives or is sent from now on is encrypted. Turning it off stores new mail unencrypted; what's already encrypted stays that way. Only personal mailboxes can be encrypted.">
        {status.mailboxes.length === 0 ? (
          <p className="text-muted-foreground text-sm">You have no personal mailboxes. An admin can make a mailbox personal in Settings, under Mailboxes.</p>
        ) : (
          <ul className="divide-y">
            {status.mailboxes.map((mailbox) => (
              <li key={mailbox.id} className="flex items-center gap-3 py-2">
                <span className="min-w-0 flex-1 truncate text-sm">
                  {mailbox.address} <span className="text-muted-foreground text-xs">{mailbox.workspace}</span>
                </span>
                <Switch
                  aria-label={`Encrypt ${mailbox.address}`}
                  checked={mailbox.encrypted}
                  onCheckedChange={(encrypted) => {
                    if (!encrypted) return setEncrypted(mailbox, false);
                    setUnderstood(false);
                    setConfirming(mailbox);
                  }}
                />
              </li>
            ))}
          </ul>
        )}
        <Dialog open={confirming !== null} onOpenChange={(open) => { if (!open) setConfirming(null); }}>
          <DialogPopup className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Encrypt {confirming?.address}?</DialogTitle>
              <DialogDescription>
                From now on, mail to and from this address is stored so that only your passphrase or recovery code can open it.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel className="space-y-3">
              <FeatureWarning title="What changes for this mailbox" />
              <Label className="flex items-start gap-2 font-normal">
                <Checkbox checked={understood} onCheckedChange={(checked) => setUnderstood(checked === true)} />
                I understand that these features won&apos;t work on its encrypted mail, and that losing both my passphrase and recovery code loses that mail.
              </Label>
            </DialogPanel>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setConfirming(null)}>Cancel</Button>
              <Button disabled={!understood} loading={running} onClick={() => confirming && setEncrypted(confirming, true)}>
                <LockSimple /> Encrypt mailbox
              </Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      </Section>

      <Section title="Change passphrase">
        <Form
          className="space-y-3"
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            const target = event.currentTarget;
            const form = new FormData(target);
            start(async () => {
              await changePassphrase(String(form.get("current")), String(form.get("next")));
              target.reset();
            }, "Passphrase changed");
          }}
        >
          <Field><FieldLabel>Current passphrase</FieldLabel><PasswordInput name="current" required autoComplete="off" /></Field>
          <Field><FieldLabel>New passphrase</FieldLabel><PasswordInput name="next" required minLength={MIN_PASSPHRASE} autoComplete="new-password" /></Field>
          <Button type="submit" variant="outline" loading={running}>Change passphrase</Button>
        </Form>
      </Section>

      <Section title="Forgot your passphrase?" description="Your recovery code unlocks your keys and sets a new passphrase. Your mail stays as it is.">
        <Form
          className="space-y-3"
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            const target = event.currentTarget;
            const form = new FormData(target);
            start(async () => {
              await recoverWithCode(String(form.get("code")), String(form.get("next")));
              target.reset();
            }, "New passphrase set, and this device is unlocked");
          }}
        >
          <Field><FieldLabel>Recovery code</FieldLabel><Input name="code" required autoComplete="off" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" className="font-mono" /></Field>
          <Field><FieldLabel>New passphrase</FieldLabel><PasswordInput name="next" required minLength={MIN_PASSPHRASE} autoComplete="new-password" /></Field>
          <Button type="submit" variant="outline" loading={running}>Recover</Button>
        </Form>
      </Section>

      <DeleteKeys />
    </>
  );
}

function DeleteKeys() {
  const [running, start] = useRunning();
  const [typed, setTyped] = useState("");
  const phrase = "DELETE MY KEYS";
  return (
    <Section title="Delete encryption keys" tone="danger" description="Every encrypted message becomes unreadable for good, on every device. New mail is stored unencrypted.">
      <Field>
        <FieldLabel>Type {phrase} to confirm</FieldLabel>
        <Input value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" />
      </Field>
      <Button
        variant="destructive"
        disabled={typed !== phrase}
        loading={running}
        onClick={() => start(async () => {
          await call("/account/vault/delete", { confirm: phrase });
          await lockVault();
          await refreshVault();
          setTyped("");
        }, "Encryption keys deleted")}
      >
        Delete keys
      </Button>
    </Section>
  );
}
