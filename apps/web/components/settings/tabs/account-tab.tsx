"use client";

import { DownloadSimple, Key, Play, ShieldCheck } from "@phosphor-icons/react";
import Link from "next/link";
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import QRCode from "react-qr-code";
import { GitHubIcon, GoogleIcon } from "@/components/brand-icons";
import { PasswordInput } from "@/components/password-input";
import { ProfilePhoto } from "@/components/profile-photo";
import { AccentPicker } from "@/components/accent-picker";
import { Segmented } from "@/components/segmented";
import { setTheme, type ThemeMode, useTheme } from "@/components/theme";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { OTPField, OTPFieldInput, OTPFieldSeparator } from "@/components/ui/otp-field";
import { Switch } from "@/components/ui/switch";
import { type Bootstrap, call } from "@/core/client/api";
import { authClient } from "@/core/client/auth-client";
import { clientExtensions } from "@/core/client/extensions";
import { rememberAfterSignIn } from "@/core/client/after-sign-in";
import { CopyButton, Section, useRun } from "../shared";

async function unwrap<T>(promise: Promise<{ data: T | null; error: { message?: string } | null }>) {
  const { data, error } = await promise;
  if (error) throw new Error(error.message ?? "Something went wrong");
  return data as T;
}

const OTP_SLOTS = ["a", "b", "c", "d", "e", "f"];

type SecurityStatus = { hasPassword: boolean; providers: string[]; recentUntil: number };

function useSecurityStatus() {
  const [status, setStatus] = useState<(SecurityStatus & { recent: boolean }) | null>(null);
  const reload = useCallback(() => {
    call("/account/security").then(
      (next) => setStatus({ ...next, recent: next.recentUntil > Date.now() }),
      () => setStatus(null),
    );
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);
  // Locks the forms again when the recent sign-in window closes.
  useEffect(() => {
    if (!status?.recent) return;
    const timer = setTimeout(
      () => setStatus((current) => current && { ...current, recent: false }),
      status.recentUntil - Date.now(),
    );
    return () => clearTimeout(timer);
  }, [status]);
  return status && { ...status, reload };
}

const SIGN_IN_PROVIDERS: Record<string, { label: string; icon: ReactNode }> = {
  google: { label: "Google", icon: <GoogleIcon /> },
  github: { label: "GitHub", icon: <GitHubIcon /> },
};

const SETTINGS_RETURN = "/settings?tab=account";

// Sends people without a password back through their provider. The fresh session that
// comes back is what unlocks the change for the next few minutes.
function ConfirmIdentity({ providers }: { providers: string[] }) {
  const run = useRun();
  const reauth = (provider: string) =>
    run(async () => {
      rememberAfterSignIn(SETTINGS_RETURN);
      // Any other provider is the workspace's SSO, which only cloud knows how to start.
      const { reauthSso } = clientExtensions;
      const result = SIGN_IN_PROVIDERS[provider]
        ? await authClient.signIn.social({ provider, callbackURL: SETTINGS_RETURN })
        : await reauthSso?.(provider, SETTINGS_RETURN);
      const error = result?.error;
      if (error) throw new Error(error.message ?? "We couldn't start the sign-in");
    });
  return (
    <Alert className="mb-3">
      <ShieldCheck />
      <AlertDescription className="space-y-2">
        <p>For your security, sign in again to confirm it&apos;s you. It unlocks these changes for 10 minutes.</p>
        <div className="flex flex-wrap gap-2">
          {providers.map((provider) => (
            <Button key={provider} size="sm" variant="outline" onClick={() => reauth(provider)}>
              {SIGN_IN_PROVIDERS[provider]?.icon ?? <Key />} Sign in again with {SIGN_IN_PROVIDERS[provider]?.label ?? "SSO"}
            </Button>
          ))}
        </div>
      </AlertDescription>
    </Alert>
  );
}

export function AccountTab({ data, refresh }: { data: Bootstrap; refresh: () => void }) {
  const run = useRun();
  const theme = useTheme();
  const { data: session } = authClient.useSession();
  const [sessions, setSessions] = useState<{ id: string; token: string; userAgent?: string | null }[]>([]);
  const [setup, setSetup] = useState<{ uri: string; backupCodes: string[] } | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [deletePassword, setDeletePassword] = useState("");
  const [showWorkspaceUnread, setShowWorkspaceUnread] = useState(data.user.showWorkspaceUnread);

  const loadSessions = useCallback(
    () => authClient.listSessions().then(({ data: rows }) => setSessions(rows ?? [])),
    [],
  );
  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const twoFactorOn = Boolean((session?.user as { twoFactorEnabled?: boolean } | undefined)?.twoFactorEnabled);
  const security = useSecurityStatus();
  const hasPassword = security?.hasPassword ?? true;
  // Without a password, a recent sign-in is what confirms it's them.
  const needsReauth = Boolean(security && !hasPassword && !security.recent);

  return (
    <div className="space-y-4">
      <Section title="Profile">
        <ProfilePhoto name={data.user.name} email={data.user.email} image={data.user.image} onChanged={refresh} />
      </Section>

      <Section title="Appearance" description="Saved on this device. The theme follows your system unless you choose otherwise.">
        <Segmented label="Theme" value={theme} onChange={(value: ThemeMode) => setTheme(value)} options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
        <div className="space-y-2 pt-1">
          <p className="font-medium text-foreground text-sm">Accent</p>
          <AccentPicker />
        </div>
        <Label className="flex items-center justify-between gap-4 pt-1 font-normal">
          <span className="space-y-0.5">
            <span className="block font-medium text-foreground text-sm">Unread counts in the workspace menu</span>
            <span className="block text-muted-foreground text-xs">Unread Inbox mail in each workspace. Saved to your account.</span>
          </span>
          <Switch
            checked={showWorkspaceUnread}
            onCheckedChange={async (checked) => {
              setShowWorkspaceUnread(checked);
              if (await run(() => call("/account/preferences", { showWorkspaceUnread: checked }))) refresh();
              else setShowWorkspaceUnread(!checked);
            }}
          />
        </Label>
      </Section>

      <Section title="Getting started" description="Go through the setup and the tour of the app again.">
        <Button className="w-fit" variant="outline" render={<Link href="/onboarding?replay=1" />}><Play /> Replay onboarding</Button>
      </Section>

      <Section
        title={hasPassword ? "Change password" : "Add a password"}
        description={hasPassword ? undefined : "You sign in with a provider, so there's no current password. Add one to also sign in with your email."}
      >
        {needsReauth && security && <ConfirmIdentity providers={security.providers} />}
        <Form
          className="space-y-3"
          onSubmit={async (event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            const target = event.currentTarget;
            const form = new FormData(target);
            const newPassword = String(form.get("next"));
            const done = hasPassword
              ? await run(
                  () => unwrap(authClient.changePassword({
                    currentPassword: String(form.get("current")),
                    newPassword,
                    revokeOtherSessions: true,
                  })),
                  "Password changed. Other devices were signed out.",
                )
              : await run(() => call("/account/add-password", { newPassword }), "Password added");
            if (done) {
              target.reset();
              security?.reload();
            }
          }}
        >
          <Field>
            <FieldLabel>Current password</FieldLabel>
            <PasswordInput name="current" required={hasPassword} disabled={!hasPassword} autoComplete="current-password" />
            {!hasPassword && <FieldDescription>Not needed. Signing in again confirms it&apos;s you.</FieldDescription>}
          </Field>
          <Field>
            <FieldLabel>New password</FieldLabel>
            <PasswordInput name="next" required minLength={10} disabled={needsReauth} autoComplete="new-password" />
            <FieldDescription>At least 10 characters.</FieldDescription>
          </Field>
          <Button type="submit" variant="outline" disabled={needsReauth}>{hasPassword ? "Change password" : "Add password"}</Button>
        </Form>
      </Section>

      <Section title="Two-factor authentication" description="Your inbox can receive password resets for other services, so it's worth protecting.">
        {setup ? (
          <div className="space-y-4">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
              {/* eslint-disable-next-line hellobox/no-hard-coded-colors -- QR codes need a white quiet zone to scan, in both themes */}
              <div className="w-fit rounded-xl border bg-white p-3"><QRCode value={setup.uri} size={136} /></div>
              <p className="text-muted-foreground text-sm">Scan this with your authenticator app, then enter the 6-digit code it shows.</p>
            </div>
            <Form
              className="flex flex-wrap items-center gap-2"
              onSubmit={async (event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                const done = await run(() => unwrap(authClient.twoFactor.verifyTotp({ code })), "Two-factor is on");
                if (done) { setSetup(null); setCode(""); }
              }}
            >
              <OTPField length={6} value={code} onValueChange={setCode}>
                {OTP_SLOTS.slice(0, 3).map((slot, index) => <OTPFieldInput key={slot} aria-label={`Digit ${index + 1} of 6`} />)}
                <OTPFieldSeparator />
                {OTP_SLOTS.slice(3).map((slot, index) => <OTPFieldInput key={slot} aria-label={`Digit ${index + 4} of 6`} />)}
              </OTPField>
              <Button type="submit">Confirm</Button>
            </Form>
            <div className="rounded-xl bg-muted p-3">
              <p className="mb-2 font-medium text-foreground text-sm">Save your backup codes somewhere safe</p>
              <code className="grid grid-cols-2 gap-1 font-mono text-muted-foreground text-xs sm:grid-cols-4">
                {setup.backupCodes.map((backup) => <span key={backup}>{backup}</span>)}
              </code>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => downloadBackupCodes(setup.backupCodes, session?.user.email)}>
                  <DownloadSimple /> Download
                </Button>
                <CopyButton value={setup.backupCodes.join("\n")} />
              </div>
            </div>
          </div>
        ) : (
          <Form
            className="flex flex-wrap items-end gap-2"
            onSubmit={async (event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              const confirm = hasPassword ? { password } : {};
              if (twoFactorOn) {
                const done = await run(() => unwrap(authClient.twoFactor.disable(confirm)), "Two-factor is off");
                if (done) setPassword("");
              } else {
                await run(async () => {
                  const result = await unwrap(authClient.twoFactor.enable(confirm));
                  if (result.method === "totp") setSetup({ uri: result.totpURI, backupCodes: result.backupCodes });
                  setPassword("");
                });
              }
            }}
          >
            {hasPassword ? (
              <Field className="min-w-56 flex-1">
                <FieldLabel>Confirm your password</FieldLabel>
                <PasswordInput required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
              </Field>
            ) : (
              needsReauth && security && <ConfirmIdentity providers={security.providers} />
            )}
            <Button type="submit" variant={twoFactorOn ? "destructive-outline" : "default"} disabled={needsReauth}>
              <ShieldCheck /> {twoFactorOn ? "Turn off" : "Turn on"}
            </Button>
          </Form>
        )}
      </Section>

      <Section title="Active sessions">
        <ul className="divide-y">
          {sessions.map((item) => (
            <li key={item.id} className="flex items-center gap-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{item.userAgent ?? "Unknown device"}</span>
              {item.id === session?.session.id ? (
                <Badge variant="secondary">This device</Badge>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    await run(() => unwrap(authClient.revokeSession({ token: item.token })), "Signed out");
                    loadSessions();
                  }}
                >
                  Sign out
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Your data" tone="danger">
        <div className="flex flex-wrap gap-2">
          {data.role !== "member" && (
            <Button
              variant="outline"
              onClick={() =>
                run(async () => {
                  const body = await call("/account/export");
                  const url = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: "application/json" }));
                  const link = document.createElement("a");
                  link.href = url;
                  link.download = "hellobox-export.json";
                  link.click();
                  URL.revokeObjectURL(url);
                })
              }
            >
              Export workspace data
            </Button>
          )}
          <AlertDialog>
            <AlertDialogTrigger render={<Button variant="destructive-outline" />}>Delete account</AlertDialogTrigger>
            <AlertDialogPopup>
              <Form
                className="contents"
                onSubmit={async (event: FormEvent<HTMLFormElement>) => {
                  event.preventDefault();
                  const done = await run(() => unwrap(authClient.deleteUser(hasPassword ? { password: deletePassword } : {})));
                  if (done) window.location.href = "/";
                }}
              >
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete your account?</AlertDialogTitle>
                  <AlertDialogDescription>This permanently deletes your account and any workspace only you belong to, including its mail. It can&apos;t be undone.</AlertDialogDescription>
                  {hasPassword ? (
                    <Field className="mt-2">
                      <FieldLabel>Enter your password to confirm</FieldLabel>
                      <PasswordInput required value={deletePassword} onChange={(e) => setDeletePassword(e.target.value)} autoComplete="current-password" />
                    </Field>
                  ) : (
                    needsReauth && security && <div className="mt-2"><ConfirmIdentity providers={security.providers} /></div>
                  )}
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogClose render={<Button variant="ghost" />}>Keep my account</AlertDialogClose>
                  <Button type="submit" variant="destructive" disabled={needsReauth}>Delete account</Button>
                </AlertDialogFooter>
              </Form>
            </AlertDialogPopup>
          </AlertDialog>
        </div>
      </Section>
    </div>
  );
}

function downloadBackupCodes(codes: string[], email?: string) {
  const lines = [
    "Hellobox two-factor backup codes",
    ...(email ? [`Account: ${email}`] : []),
    `Generated: ${new Date().toISOString().slice(0, 10)}`,
    "",
    "Each code can be used once to sign in if you lose access to your authenticator app.",
    "",
    ...codes,
    "",
  ];
  const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "hellobox-backup-codes.txt";
  link.click();
  URL.revokeObjectURL(url);
}
