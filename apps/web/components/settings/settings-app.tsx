"use client";

import {
  ArrowElbowDownRight, ArrowLeft, BellRinging, ChatCircleText, Check, Copy, DownloadSimple, Globe, Key, LockKey, DotsThree, ListChecks, LockSimple, LockSimpleOpen, Play, Plugs, Prohibit, Robot, ShieldCheck, Sparkle,
  Trash, Tray, UserCircle, UsersThree,
} from "@phosphor-icons/react";
import Link from "next/link";
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import QRCode from "react-qr-code";
import { groupDomains, planDomainCount } from "@hellobox/mail/domain-names";
import { PROVIDER_INFO } from "@hellobox/providers/types";
import { Logo } from "@/components/brand";
import { SenderAvatar } from "@/components/mail/sender-avatar";
import { GitHubIcon, GoogleIcon } from "@/components/brand-icons";
import { PasswordInput } from "@/components/password-input";
import { ProfilePhoto } from "@/components/profile-photo";
import { WorkspaceLogoPicker } from "@/components/workspace-logo";
import { NotificationsTab } from "./notifications-tab";
import { EncryptionTab } from "./encryption";
import { AppProviders } from "@/components/providers";
import { AccentPicker } from "@/components/accent-picker";
import { Segmented } from "@/components/segmented";
import { setTheme, type ThemeMode, useTheme } from "@/components/theme";
import {
  AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup,
  AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { OTPField, OTPFieldInput, OTPFieldSeparator } from "@/components/ui/otp-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { AGENT_SCOPE_LABELS, AGENT_SCOPES, AGENT_TOKEN_LIFETIMES, type AgentScope, normalizeScopes } from "@/core/agent-scopes";
import { ApiError, type Bootstrap, call, clearWorkspaceId } from "@/core/client/api";
import { authClient } from "@/core/client/auth-client";
import { safeAvatarUrl } from "@/core/avatar";
import { useEntitlementsChanged } from "@/core/client/entitlements-store";
import { clientExtensions } from "@/core/client/extensions";
import { notifyError, notifyInfo } from "@/core/client/notify";
import { rememberAfterSignIn } from "@/core/client/after-sign-in";
import { useSearchParam } from "@/core/client/use-search-param";
import { cn } from "@/lib/utils";
import { MailboxPicker } from "./mailbox-picker";
import { ClaimDomainButton, claimedState, IncomingClaims } from "./domain-claims";
import { FeedbackContent } from "@/components/feedback";
import { connectionLabel, ProvidersSection } from "./providers-section";
import { BounceChoice } from "./bounce-choice";
import { Section, useRun, useRunning } from "./shared";


async function unwrap<T>(promise: Promise<{ data: T | null; error: { message?: string } | null }>) {
  const { data, error } = await promise;
  if (error) throw new Error(error.message ?? "Something went wrong");
  return data as T;
}

const { UpgradeHint } = clientExtensions;

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

function AccountTab({ data, refresh }: { data: Bootstrap; refresh: () => void }) {
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

function MailboxesTab({ data, refresh }: { data: Bootstrap; refresh: () => void }) {
  const run = useRun();
  const [address, setAddress] = useState("");
  const admin = data.role !== "member";
  const [people, setPeople] = useState<{ userId: string; name: string; email: string }[]>([]);
  const [makingPersonal, setMakingPersonal] = useState<{ id: string; address: string; userId: string } | null>(null);
  useEffect(() => {
    if (admin) call("/members/list").then((team) => setPeople(team.members)).catch(() => undefined);
  }, [admin]);
  return (
    <div className="space-y-4">
      <Section title="Mailboxes" description="Only the addresses you add here receive mail. Mail to any other address at your domains goes to Spam and is deleted after 24 hours. A personal mailbox is read by one person only, admins included.">
        <ul className="divide-y">
          {(admin ? data.managedMailboxes : data.mailboxes.map((mailbox) => ({ ...mailbox, personalUserId: mailbox.personalUserId ?? null }))).map((mailbox) => {
            const mine = mailbox.personalUserId === data.user.id;
            const ownerName = mailbox.personalUserId && (mine ? "you" : people.find((person) => person.userId === mailbox.personalUserId)?.name);
            return (
              <li key={mailbox.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <span className="flex min-w-40 flex-1 flex-wrap items-center gap-2 break-all text-foreground">
                  {mailbox.address}
                  {mailbox.personalUserId && (
                    <Badge variant="secondary" className="gap-1"><LockSimple weight="fill" /> Personal{ownerName ? ` · ${ownerName}` : ""}</Badge>
                  )}
                </span>
                {admin ? (
                  <Input
                    key={mailbox.displayName}
                    className="w-full sm:w-52"
                    maxLength={100}
                    aria-label={`Sender name for ${mailbox.address}`}
                    placeholder="Sender name"
                    defaultValue={mailbox.displayName ?? ""}
                    onBlur={async (event) => {
                      const displayName = event.target.value.trim() || null;
                      if (displayName === mailbox.displayName) return;
                      await run(() => call("/mailboxes/update", { id: mailbox.id, displayName }), "Sender name saved");
                      refresh();
                    }}
                  />
                ) : (
                  mailbox.displayName && <span className="text-muted-foreground">{mailbox.displayName}</span>
                )}
                {((admin && !mailbox.personalUserId && data.entitlements.features.team) || mine) ? (
                  <Menu>
                    <MenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label={`More for ${mailbox.address}`} />}><DotsThree weight="bold" /></MenuTrigger>
                    <MenuPopup align="end">
                      {mine ? (
                        <MenuItem onClick={async () => { if (await run(() => call("/mailboxes/set-personal", { id: mailbox.id, userId: null }), "Mailbox shared")) refresh(); }}>
                          <LockSimpleOpen /> Make shared
                        </MenuItem>
                      ) : (
                        <MenuItem onClick={() => setMakingPersonal({ id: mailbox.id, address: mailbox.address, userId: "" })}>
                          <LockSimple /> Make personal…
                        </MenuItem>
                      )}
                    </MenuPopup>
                  </Menu>
                ) : admin && <span aria-hidden className="size-8" />}
                {admin && <DeleteMailboxButton mailbox={mailbox} refresh={refresh} />}
              </li>
            );
          })}
        </ul>
        {admin && (
          <Form
            className="flex gap-2"
            onSubmit={async (event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              const done = await run(() => call("/mailboxes/create", { address }), "Mailbox added");
              if (done) { setAddress(""); refresh(); }
            }}
          >
            <Input type="email" required aria-label="Mailbox address" placeholder="hello@yourdomain.com" value={address} onChange={(e) => setAddress(e.target.value)} />
            <Button type="submit" variant="outline">Add</Button>
          </Form>
        )}
      </Section>

      <Section
        title="Mail to addresses that don't exist"
        description={admin ? "Whether HelloBox tells the sender when they write to an address with no mailbox." : "Whether HelloBox tells the sender when they write to an address with no mailbox. Only workspace admins can change this."}
      >
        <BounceChoice
          enabled={data.workspace.bouncesEnabled}
          disabled={!admin}
          onChange={async (enabled) => {
            if (await run(() => call("/workspace/bounces", { enabled }), enabled ? "Bounces turned on" : "Bounces turned off")) refresh();
          }}
        />
      </Section>

      <Dialog open={makingPersonal !== null} onOpenChange={(open) => { if (!open) setMakingPersonal(null); }}>
        <DialogPopup className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Make {makingPersonal?.address} personal</DialogTitle>
            <DialogDescription>
              Only the person you choose will read it. Everyone else loses access, admins and you included, and only they can share it again.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Field>
              <FieldLabel>Belongs to</FieldLabel>
              <Select
                value={makingPersonal?.userId ?? ""}
                onValueChange={(userId) => setMakingPersonal((current) => current && { ...current, userId: String(userId ?? "") })}
                items={people.map((person) => ({ label: person.userId === data.user.id ? `${person.name} (you)` : person.name, value: person.userId }))}
              >
                <SelectTrigger aria-label="Belongs to"><SelectValue placeholder="Choose a person" /></SelectTrigger>
                <SelectPopup>
                  {people.map((person) => (
                    <SelectItem key={person.userId} value={person.userId}>
                      <span className="grid">
                        <span>{person.userId === data.user.id ? `${person.name} (you)` : person.name}</span>
                        <span className="text-muted-foreground text-xs">{person.email}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
          </DialogPanel>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setMakingPersonal(null)}>Cancel</Button>
            <Button
              disabled={!makingPersonal?.userId}
              onClick={async () => {
                if (!makingPersonal?.userId) return;
                const { id, userId } = makingPersonal;
                if (await run(() => call("/mailboxes/set-personal", { id, userId }), "Mailbox is now personal")) {
                  setMakingPersonal(null);
                  refresh();
                }
              }}
            >
              <LockSimple /> Make personal
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

type Domain = Bootstrap["domains"][number];

function ConnectionTab({ data, refresh }: { data: Bootstrap; refresh: () => void }) {
  const domainLimit = data.entitlements.limits.domains;
  const run = useRun();
  const admin = data.role !== "member";
  const active = data.connections.filter((c) => c.status !== "disconnected");
  const connectionOf = (connectionId: string) => data.connections.find((c) => c.id === connectionId);
  const disconnected = (domain: Domain) => connectionOf(domain.connectionId)?.status === "disconnected";
  const live = data.domains.filter((d) => !d.removedAt);
  const removed = data.domains.filter((d) => d.removedAt);
  // The same rule the server counts by: on, and not on a disconnected connection, with
  // subdomains counted under their parent.
  const counted = live.filter((d) => d.enabled && !disconnected(d)).map((d) => d.name);
  const enabled = planDomainCount(counted);
  const [toggling, setToggling] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [syncing, runSync] = useRunning();
  return (
    <div className="space-y-4">
      <Section title="Email providers" description="Where your mail is sent from and received. Your provider bills for sending, not us.">
        <ProvidersSection data={data} refresh={refresh} admin={admin} />
      </Section>

      <Section
        title="Domains"
        description={`${enabled} active${domainLimit === null ? "" : ` of ${domainLimit} on your plan`}. Inactive domains keep their mail until you make room.`}
      >
        {admin && <IncomingClaims data={data} refresh={refresh} />}
        <ul className="divide-y">
          {groupDomains(live).map(({ domain, parent }) => {
            const connection = connectionOf(domain.connectionId);
            const claimed = claimedState(domain, data);
            return (
              <li key={domain.id} className={cn("flex items-center gap-3 py-2.5", parent && "ps-7")}>
                {parent
                  ? <ArrowElbowDownRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  : <Globe className="size-4 shrink-0 text-muted-foreground" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-foreground text-sm">{domain.name}</span>
                  <span className="block text-muted-foreground text-xs">
                    {connectionLabel(connection)}
                    {" · "}
                    {claimed
                      ? claimed.note
                      : disconnected(domain)
                      ? "Disconnected. Its mail stays here."
                      : domain.receivingEnabled
                        ? "Receiving on"
                        : "Receiving off"}
                  </span>
                </span>
                {admin && claimed?.kind === "other-workspace" && <ClaimDomainButton domain={domain} data={data} refresh={refresh} />}
                <Switch
                  aria-label={`Use ${domain.name}`}
                  checked={domain.enabled}
                  disabled={!admin || toggling !== null || claimed !== null}
                  onCheckedChange={async (checked) => {
                    setToggling(domain.id);
                    await run(() => call("/domains/set-enabled", { id: domain.id, enabled: checked }));
                    setToggling(null);
                    refresh();
                  }}
                />
                {admin && <RemoveDomainButton domain={domain} data={data} refresh={refresh} />}
              </li>
            );
          })}
          {live.length === 0 && <li className="py-2 text-muted-foreground text-sm">No domains yet.</li>}
        </ul>
        {removed.length > 0 && (
          <div className="space-y-1">
            <p className="font-medium text-foreground text-sm">Removed from HelloBox</p>
            <p className="text-muted-foreground text-xs">Their mail stays here to read. Restore one, or add it again, to send and receive with it.</p>
            <ul className="divide-y">
              {removed.map((domain) => (
                <li key={domain.id} className="flex items-center gap-3 py-2.5">
                  <Globe className="size-4 shrink-0 text-muted-foreground opacity-64" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-muted-foreground text-sm">{domain.name}</span>
                    <span className="block truncate text-muted-foreground text-xs">{connectionLabel(connectionOf(domain.connectionId))}</span>
                  </span>
                  {admin && (
                    <Button
                      size="xs"
                      variant="outline"
                      loading={restoring === domain.id}
                      disabled={restoring !== null}
                      onClick={async () => {
                        setRestoring(domain.id);
                        await run(async () => {
                          const result = await call("/domains/restore", { id: domain.id });
                          if (result.offBecause === "claimed") notifyInfo(`${domain.name} is back, but switched off. It's on somewhere else now.`);
                          else if (!result.enabled) notifyInfo(`${domain.name} is back, but switched off. Your plan has no room for another domain.`);
                        }, `${domain.name} restored`);
                        setRestoring(null);
                        refresh();
                      }}
                    >
                      Restore
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {admin && UpgradeHint && domainLimit !== null && enabled >= domainLimit && <UpgradeHint data={data} reason="domains" />}
        {admin && active.length > 0 && (
          <Button size="sm" variant="outline" loading={syncing} onClick={async () => { await runSync(() => call("/domains/sync"), "Domains updated"); refresh(); }}>
            Refresh domains
          </Button>
        )}
      </Section>

    </div>
  );
}

function DeleteMailboxButton({ mailbox, refresh }: { mailbox: { id: string; address: string; personalUserId: string | null }; refresh: () => void }) {
  const run = useRun();
  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button size="icon-sm" variant="ghost" aria-label={`Delete ${mailbox.address}`} title="Delete mailbox" />}>
        <Trash />
      </AlertDialogTrigger>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {mailbox.address}?</AlertDialogTitle>
          <AlertDialogDescription render={<div />} className="space-y-2">
            <p>It leaves the sidebar and the From list, and nobody can send from it.</p>
            <p>
              Its conversations aren&apos;t deleted: {mailbox.personalUserId ? "its owner" : "whoever could read them"} still finds them under All mail and in search. New mail to this address is treated like mail to an address with no mailbox: it goes to Spam and is deleted after 24 hours.
            </p>
            <p>Add the address again to bring the mailbox back.</p>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>Keep mailbox</AlertDialogClose>
          <AlertDialogClose
            render={<Button variant="destructive" />}
            onClick={async () => {
              if (await run(() => call("/mailboxes/delete", { id: mailbox.id }), `${mailbox.address} deleted`)) refresh();
            }}
          >
            Delete mailbox
          </AlertDialogClose>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function RemoveDomainButton({ domain, data, refresh }: { domain: Domain; data: Bootstrap; refresh: () => void }) {
  const run = useRun();
  const connectionOf = (connectionId: string) => data.connections.find((c) => c.id === connectionId);
  const connection = connectionOf(domain.connectionId);
  const providerName = connection ? PROVIDER_INFO[connection.provider].name : "provider";
  const mailboxCount = data.managedMailboxes.filter((m) => m.domainId === domain.id).length;
  // Where the server moves the mailboxes: the same domain on another live connection, one that's on first.
  const successor = data.domains
    .filter((d) => d.id !== domain.id && d.name === domain.name && !d.removedAt && connectionOf(d.connectionId)?.status !== "disconnected")
    .sort((a, b) => Number(b.enabled) - Number(a.enabled))[0];
  const stopsReceiving =
    connection !== undefined && connection.provider !== "resend" && connection.status === "active" && domain.receivingEnabled;
  const mailboxes = `${mailboxCount} ${mailboxCount === 1 ? "mailbox" : "mailboxes"}`;
  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button size="icon-sm" variant="ghost" aria-label={`Remove ${domain.name}`} title="Remove from HelloBox" />}>
        <Trash />
      </AlertDialogTrigger>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {domain.name} from HelloBox?</AlertDialogTitle>
          <AlertDialogDescription render={<div />} className="space-y-2">
            <p>
              It stops counting toward your plan
              {stopsReceiving ? `, and ${providerName} stops sending its new mail to HelloBox` : ""}.
            </p>
            {mailboxCount > 0 && (
              <p>
                {successor
                  ? `Its ${mailboxes} move, with their mail, to ${domain.name} on ${connectionLabel(connectionOf(successor.connectionId))}.${successor.enabled ? "" : " That one is switched off, so their mail shows again once you switch it on."}`
                  : `Its ${mailboxes} and their mail stay here to read. You can't send from them until you add the domain again.`}
              </p>
            )}
            <p>{domain.name} stays in your {providerName} account ({connectionLabel(connection)}). Delete it there if you no longer need it.</p>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>Keep domain</AlertDialogClose>
          <AlertDialogClose
            render={<Button variant="destructive" />}
            onClick={async () => {
              await run(() => call("/domains/remove", { id: domain.id }), `${domain.name} removed`);
              refresh();
            }}
          >
            Remove domain
          </AlertDialogClose>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function WorkspaceSection({ data, refresh, others, reload }: {
  data: Bootstrap;
  refresh: () => void;
  others: { userId: string; name: string }[];
  reload: () => void;
}) {
  const run = useRun();
  const [name, setName] = useState(data.workspace.name);
  const [transferTo, setTransferTo] = useState<string | null>(null);
  const admin = data.role !== "member";
  const owner = data.role === "owner";
  // The saved workspace is gone from this person's list, so fall back to their first one.
  const leave = () => {
    clearWorkspaceId();
    window.location.href = "/inbox";
  };
  return (
    <Section title="Workspace" description={admin ? "Shown to everyone here when they switch workspaces." : data.workspace.name}>
      {admin && (
        <Form
          className="flex gap-2"
          onSubmit={async (event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            if (await run(() => call("/workspace/rename", { name }), "Workspace renamed")) refresh();
          }}
        >
          <Input required maxLength={80} aria-label="Workspace name" value={name} onChange={(event) => setName(event.target.value)} />
          <Button type="submit" variant="outline" disabled={name.trim() === data.workspace.name}>Save</Button>
        </Form>
      )}
      {admin && <WorkspaceLogoPicker name={data.workspace.name} logo={data.workspace.logo} onChanged={refresh} />}
      <div className="flex flex-wrap gap-2">
        {owner && others.length > 0 && (
          <AlertDialog>
            <AlertDialogTrigger render={<Button size="sm" variant="outline" />}>Transfer ownership</AlertDialogTrigger>
            <AlertDialogPopup>
              <AlertDialogHeader>
                <AlertDialogTitle>Transfer this workspace?</AlertDialogTitle>
                <AlertDialogDescription>The new owner controls billing and can delete the workspace. You become an admin.</AlertDialogDescription>
              </AlertDialogHeader>
              <div className="px-6 pb-4">
                <Select value={transferTo} onValueChange={setTransferTo} items={others.map((person) => ({ label: person.name, value: person.userId }))}>
                  <SelectTrigger aria-label="New owner"><SelectValue placeholder="Choose a teammate" /></SelectTrigger>
                  <SelectPopup>{others.map((person) => <SelectItem key={person.userId} value={person.userId}>{person.name}</SelectItem>)}</SelectPopup>
                </Select>
              </div>
              <AlertDialogFooter>
                <AlertDialogClose render={<Button variant="ghost" />}>Keep ownership</AlertDialogClose>
                <AlertDialogClose
                  render={<Button variant="destructive" disabled={!transferTo} />}
                  onClick={async () => {
                    if (!transferTo) return;
                    if (await run(() => call("/workspace/transfer", { userId: transferTo }), "Ownership transferred")) {
                      refresh();
                      reload();
                    }
                  }}
                >
                  Transfer
                </AlertDialogClose>
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
        )}
        {owner ? (
          <AlertDialog>
            <AlertDialogTrigger render={<Button size="sm" variant="destructive-outline" />}>Delete workspace</AlertDialogTrigger>
            <AlertDialogPopup>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete {data.workspace.name}?</AlertDialogTitle>
                <AlertDialogDescription>All of this workspace&apos;s mail, attachments and settings are permanently deleted for everyone. Your Resend account isn&apos;t affected.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose render={<Button variant="ghost" />}>Keep workspace</AlertDialogClose>
                <AlertDialogClose
                  render={<Button variant="destructive" />}
                  onClick={async () => {
                    if (await run(() => call("/workspace/delete"), "Workspace deleted")) leave();
                  }}
                >
                  Delete workspace
                </AlertDialogClose>
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
        ) : (
          <AlertDialog>
            <AlertDialogTrigger render={<Button size="sm" variant="destructive-outline" />}>Leave workspace</AlertDialogTrigger>
            <AlertDialogPopup>
              <AlertDialogHeader>
                <AlertDialogTitle>Leave {data.workspace.name}?</AlertDialogTitle>
                <AlertDialogDescription>You lose access to its mail until someone invites you again.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose render={<Button variant="ghost" />}>Stay</AlertDialogClose>
                <AlertDialogClose
                  render={<Button variant="destructive" />}
                  onClick={async () => {
                    if (await run(() => call("/workspace/leave"), "You left the workspace")) leave();
                  }}
                >
                  Leave
                </AlertDialogClose>
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
        )}
      </div>
    </Section>
  );
}

const ROLE_OPTIONS = [
  { label: "Member", value: "member" as const },
  { label: "Admin", value: "admin" as const },
];

function TeamTab({ data, refresh }: { data: Bootstrap; refresh: () => void }) {
  const memberLimit = data.entitlements.limits.members;
  const run = useRun();
  const [team, setTeam] = useState<Awaited<ReturnType<typeof call<"/members/list">>> | null>(null);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"member" | "admin">("member");
  const [editing, setEditing] = useState<{ userId: string; name: string; mailboxIds: string[] } | null>(null);
  const load = useCallback(() => call("/members/list").then(setTeam), []);
  useEffect(() => {
    load();
  }, [load]);
  const admin = data.role !== "member";
  const atLimit = Boolean(team) && (team?.members.length ?? 0) + (team?.invitations.length ?? 0) >= (memberLimit ?? Number.POSITIVE_INFINITY);
  const owner = data.role === "owner";
  // Only shared mailboxes are handed out; personal ones stay with their person.
  const sharedMailboxes = data.managedMailboxes.filter((mailbox) => !mailbox.personalUserId);
  const sharedIds = new Set(sharedMailboxes.map((mailbox) => mailbox.id));
  return (
    <div className="space-y-4">
    <WorkspaceSection
      data={data}
      refresh={refresh}
      reload={load}
      others={(team?.members ?? []).filter((member) => member.userId !== data.user.id)}
    />
    <Section
      title="Team"
      description={!data.entitlements.features.team ? "Inviting teammates needs a paid plan." : memberLimit === null ? undefined : `Up to ${memberLimit} members on your plan.`}
    >
      <ul className="divide-y">
        {team?.members.map((member) => (
          <li key={member.userId} className="flex flex-wrap items-center gap-2 py-2 text-sm">
            <SenderAvatar name={member.name} src={safeAvatarUrl(member.image)} className="size-7" />
            <span className="min-w-0 flex-1 truncate text-foreground">{member.name} <span className="text-muted-foreground">{member.email}</span></span>
            {owner && member.role !== "owner" ? (
              <Select
                value={member.role}
                items={ROLE_OPTIONS}
                onValueChange={async (role) => {
                  if (!role || role === member.role) return;
                  await run(() => call("/members/update", { userId: member.userId, role }), "Role updated");
                  load();
                }}
              >
                <SelectTrigger size="sm" aria-label={`Role for ${member.name}`} className="w-28"><SelectValue /></SelectTrigger>
                <SelectPopup>{ROLE_OPTIONS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectPopup>
              </Select>
            ) : (
              <Badge variant="outline" className="capitalize">{member.role}</Badge>
            )}
            {admin && data.entitlements.features.team && (() => {
              const assigned = member.mailboxIds.filter((id) => sharedIds.has(id));
              return (
                <Button size="sm" variant="outline" onClick={() => setEditing({ userId: member.userId, name: member.userId === data.user.id ? "you" : member.name, mailboxIds: assigned })}>
                  Mailboxes ({assigned.length})
                </Button>
              );
            })()}
            {admin && member.role !== "owner" && (owner || member.role === "member") && (
              <Button size="sm" variant="ghost" onClick={async () => { await run(() => call("/members/update", { userId: member.userId, role: null }), "Removed"); load(); }}>Remove</Button>
            )}
          </li>
        ))}
        {team?.invitations.map((invite) => (
          <li key={invite.id} className="flex items-center gap-2 py-2 text-sm">
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{invite.email}</span>
            <Badge variant="info">Invited</Badge>
            {admin && <Button size="sm" variant="ghost" onClick={async () => { await run(() => call("/members/revoke-invite", { id: invite.id })); load(); }}>Revoke</Button>}
          </li>
        ))}
      </ul>
      {admin && atLimit && UpgradeHint && <UpgradeHint data={data} reason="members" />}
      {admin && !atLimit && (
        <Form
          className="flex gap-2"
          onSubmit={async (event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            const done = await run(() => call("/members/invite", { email, role: inviteRole }), "Invitation sent");
            if (done) { setEmail(""); load(); }
          }}
        >
          <Input type="email" required aria-label="Teammate's email" placeholder="teammate@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          {owner && (
            <Select value={inviteRole} items={ROLE_OPTIONS} onValueChange={(role) => { if (role) setInviteRole(role); }}>
              <SelectTrigger aria-label="Role" className="w-32"><SelectValue /></SelectTrigger>
              <SelectPopup>{ROLE_OPTIONS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectPopup>
            </Select>
          )}
          <Button type="submit">Invite</Button>
        </Form>
      )}
      {admin && data.entitlements.features.team && (
        <p className="text-muted-foreground text-xs">Everyone reads only the mailboxes they&apos;re given, admins and the owner included. Personal mailboxes stay with their person and can&apos;t be handed out.</p>
      )}
      <Dialog open={editing !== null} onOpenChange={(open) => { if (!open) setEditing(null); }}>
        <DialogPopup className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Mailboxes for {editing?.name}</DialogTitle>
            <DialogDescription>{editing?.name === "you" ? "You" : "They"} can read and send from the shared mailboxes you choose.</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <MailboxPicker
              mailboxes={sharedMailboxes}
              selected={editing?.mailboxIds ?? []}
              onChange={(mailboxIds) => setEditing((current) => current && { ...current, mailboxIds })}
            />
          </DialogPanel>
          <DialogFooter>
            <Button
              onClick={async () => {
                if (!editing) return;
                const { userId, mailboxIds } = editing;
                if (await run(() => call("/members/set-mailboxes", { userId, mailboxIds }), "Mailboxes updated")) {
                  setEditing(null);
                  load();
                }
              }}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </Section>
    </div>
  );
}

const CATEGORIES = [
  { label: "Notifications", value: "notifications" },
  { label: "Purchases", value: "purchases" },
  { label: "Newsletters", value: "newsletters" },
  { label: "Primary", value: "primary" },
] as const;

// Addresses HelloBox stopped sending to after a permanent bounce or a spam report. Each
// one says why, and admins can let mail go to it again.
function SuppressionsTab({ admin }: { admin: boolean }) {
  const run = useRun();
  const [rows, setRows] = useState<Awaited<ReturnType<typeof call<"/suppressions/list">>>["suppressions"] | null>(null);
  const load = useCallback(() => call("/suppressions/list").then((result) => setRows(result.suppressions)), []);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <Section
      title="Suppressed addresses"
      description="When mail to an address bounces permanently, or someone marks your mail as spam, HelloBox stops sending to them: the composer warns first, and campaigns skip them. Sending to these again can hurt your sender reputation."
    >
      {rows === null ? (
        <Skeleton className="h-16 w-full" />
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing here. Addresses appear after a permanent bounce or a spam report.</p>
      ) : (
        <ul className="divide-y">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-start gap-x-3 gap-y-1.5 py-2.5 text-sm">
              <span className="min-w-0 flex-1 basis-56">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="break-all text-foreground">{row.email}</span>
                  <Badge variant={row.reason === "complaint" ? "error" : "warning"} size="sm">
                    {row.reason === "complaint" ? "Reported as spam" : "Bounced"}
                  </Badge>
                </span>
                <span className="mt-0.5 block text-muted-foreground text-xs">
                  {formatDay(row.updatedAt)}
                  {row.provider ? ` · reported by ${PROVIDER_INFO[row.provider].name}` : ""}
                  {row.campaignId ? " · from a campaign" : ""}
                  {row.detail ? ` · ${row.detail}` : ""}
                </span>
              </span>
              {admin && (
                <AlertDialog>
                  <AlertDialogTrigger render={<Button size="sm" variant="ghost" className="ms-auto" />}>Remove</AlertDialogTrigger>
                  <AlertDialogPopup>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Send to {row.email} again?</AlertDialogTitle>
                      <AlertDialogDescription>
                        {row.reason === "complaint"
                          ? "This person marked your mail as spam. Only remove it if they asked to hear from you again."
                          : "Mail to this address bounced permanently. Only remove it if you know the address works now."}{" "}
                        Your provider may keep its own block. This is recorded in the audit log.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogClose render={<Button variant="ghost" />}>Keep it</AlertDialogClose>
                      <AlertDialogClose
                        render={<Button variant="destructive" />}
                        onClick={async () => {
                          await run(() => call("/suppressions/remove", { id: row.id }), `${row.email} can get mail again`);
                          load();
                        }}
                      >
                        Remove
                      </AlertDialogClose>
                    </AlertDialogFooter>
                  </AlertDialogPopup>
                </AlertDialog>
              )}
            </li>
          ))}
        </ul>
      )}
      {!admin && rows && rows.length > 0 && (
        <p className="text-muted-foreground text-xs">Only workspace admins can remove an address.</p>
      )}
    </Section>
  );
}

// Personal: each person keeps their own list, and it covers the mailboxes they read.
function NeverSpamSection() {
  const run = useRun();
  const [domains, setDomains] = useState<{ domain: string }[] | null>(null);
  const [domain, setDomain] = useState("");
  const load = useCallback(() => call("/account/spam-exemptions").then((result) => setDomains(result.domains)), []);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <Section
      title="Never send to Spam"
      description="Your own list. Mail from these domains and their subdomains stays out of Spam in the mailboxes you read, even when the scanner or other HelloBox users flag it. A sender your workspace blocked still goes to Spam."
    >
      <ul className="divide-y">
        {domains?.map((row) => (
          <li key={row.domain} className="flex items-center gap-2 py-2 text-sm">
            <span className="min-w-0 flex-1 truncate text-foreground">{row.domain}</span>
            <Button size="sm" variant="ghost" onClick={async () => { await run(() => call("/account/spam-exemptions/remove", { domain: row.domain })); load(); }}>Remove</Button>
          </li>
        ))}
        {domains?.length === 0 && <li className="py-2 text-muted-foreground text-sm">No domains yet.</li>}
      </ul>
      <Form
        className="flex flex-wrap gap-2"
        onSubmit={async (event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const done = await run(() => call("/account/spam-exemptions/add", { domain }));
          if (done) { setDomain(""); load(); }
        }}
      >
        <Input className="min-w-44 flex-1" required aria-label="Domain to keep out of Spam" placeholder="example.com" value={domain} onChange={(e) => setDomain(e.target.value)} />
        <Button type="submit" variant="outline">Add domain</Button>
      </Form>
    </Section>
  );
}

function RulesTab({ admin }: { admin: boolean }) {
  const run = useRun();
  const [state, setState] = useState<Awaited<ReturnType<typeof call<"/rules/list">>> | null>(null);
  const [domain, setDomain] = useState("");
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]["value"]>("notifications");
  const load = useCallback(() => call("/rules/list").then(setState), []);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <div className="space-y-4">
      <Section title="Rules" description="The first matching rule wins, and rules beat automatic sorting.">
        <ul className="divide-y">
          {state?.rules.map((rule) => (
            <li key={rule.id} className="flex items-center gap-2 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate text-foreground">{rule.name}</span>
              {admin && <Button size="sm" variant="ghost" onClick={async () => { await run(() => call("/rules/delete", { id: rule.id })); load(); }}>Delete</Button>}
            </li>
          ))}
        </ul>
        {!admin && <p className="text-muted-foreground text-sm">Only workspace admins can change rules, because they apply to every mailbox.</p>}
        {admin && <Form
          className="flex flex-wrap gap-2"
          onSubmit={async (event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            const done = await run(() =>
              call("/rules/create", {
                name: `${domain} → ${category}`,
                conditions: [{ field: "fromDomain", op: "equals", value: domain }],
                action: { category },
              }),
            );
            if (done) { setDomain(""); load(); }
          }}
        >
          <Input className="min-w-44 flex-1" required aria-label="Sender domain" placeholder="stripe.com" value={domain} onChange={(e) => setDomain(e.target.value)} />
          <Select value={category} onValueChange={(value) => { if (value) setCategory(value); }} items={[...CATEGORIES]}>
            <SelectTrigger aria-label="Category" className="w-full sm:w-44"><SelectValue /></SelectTrigger>
            <SelectPopup>
              {CATEGORIES.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
            </SelectPopup>
          </Select>
          <Button type="submit" variant="outline">Add rule</Button>
        </Form>}
      </Section>
      <Section title="Sender lists" description="Mail from a blocked sender goes straight to Spam. You block a sender after Report spam, allow one with Not spam, and add one here when you show their images.">
        <ul className="divide-y">
          {state?.senders.map((sender) => (
            <li key={sender.id} className="flex items-center gap-2 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate text-foreground">{sender.value}</span>
              <Badge variant={sender.kind === "blocked" ? "error" : "secondary"} className="capitalize">{sender.kind.replace("_", " ")}</Badge>
              {admin && <Button size="sm" variant="ghost" onClick={async () => { await run(() => call("/senders/remove", { id: sender.id })); load(); }}>{sender.kind === "blocked" ? "Unblock" : "Remove"}</Button>}
            </li>
          ))}
          {state?.senders.length === 0 && <li className="py-2 text-muted-foreground text-sm">Nothing here yet.</li>}
        </ul>
      </Section>
      <NeverSpamSection />
    </div>
  );
}

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  groq: "Groq",
  mistral: "Mistral",
  custom: "Custom (OpenAI-compatible)",
};
const providerLabel = (value: string) => PROVIDER_LABELS[value] ?? value;

function AiTab() {
  const run = useRun();
  const [settings, setSettings] = useState<Awaited<ReturnType<typeof call<"/ai/settings">>> | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const load = useCallback(() => call("/ai/settings").then(setSettings), []);
  useEffect(() => {
    load();
  }, [load]);
  if (!settings) return <Skeleton className="h-64 w-full rounded-2xl" />;
  const providers = settings.providers.map((value) => ({ label: providerLabel(value), value }));
  const chosen = provider ?? settings.provider ?? providers[0]?.value ?? "";
  return (
    <Section title="Your AI provider" description="Bring your own key. It's encrypted, and the assistant only reads what you share. It writes drafts and can't send anything.">
      {settings.configured && (
        <div className="flex items-center gap-2">
          <Badge variant="success" className="me-auto">{providerLabel(settings.provider ?? "")} · {settings.model}</Badge>
          <Button size="sm" variant="destructive-outline" onClick={async () => { await run(() => call("/ai/remove"), "Removed"); load(); }}>Remove</Button>
        </div>
      )}
      <Form
        className="space-y-3"
        onSubmit={async (event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const target = event.currentTarget;
          const form = new FormData(target);
          const done = await run(
            () => call("/ai/save", { provider: chosen as "anthropic", model: String(form.get("model")), apiKey: String(form.get("apiKey")), baseUrl: chosen === "custom" ? String(form.get("baseUrl")) : undefined }),
            "Saved",
          );
          if (done) { target.reset(); load(); }
        }}
      >
        <Field>
          <FieldLabel>Provider</FieldLabel>
          <Select value={chosen} onValueChange={(value) => setProvider(value)} items={providers}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectPopup>{providers.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectPopup>
          </Select>
        </Field>
        {chosen === "custom" && (
          <Field>
            <FieldLabel>Base URL</FieldLabel>
            <Input key={settings.baseUrl} name="baseUrl" type="url" required placeholder="https://api.example.com/v1" defaultValue={settings.baseUrl ?? ""} />
            <FieldDescription>Any API that follows OpenAI&apos;s chat completions format. It has to be a public HTTPS address.</FieldDescription>
          </Field>
        )}
        <Field>
          <FieldLabel>Model</FieldLabel>
          <Input name="model" required />
          <FieldDescription>The exact model name from your provider.</FieldDescription>
        </Field>
        <Field><FieldLabel>API key</FieldLabel><PasswordInput name="apiKey" required autoComplete="off" /></Field>
        <Button type="submit">Save</Button>
      </Form>
    </Section>
  );
}

type AgentConnection = Awaited<ReturnType<typeof call<"/agents/list">>>[number];
type NewAgentConnection = Awaited<ReturnType<typeof call<"/agents/create">>>;
type AgentClient = "claude-code" | "claude-desktop" | "other";

const AGENT_CLIENTS: { value: AgentClient; label: string }[] = [
  { value: "claude-code", label: "Claude Code" },
  { value: "claude-desktop", label: "Claude Desktop" },
  { value: "other", label: "Other clients" },
];

const LIFETIMES = AGENT_TOKEN_LIFETIMES.map((days) => ({
  value: String(days),
  label: days === 365 ? "1 year" : `${days} days`,
}));

const formatDay = (value: Date | string) =>
  new Date(value).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

function agentSetup(client: AgentClient, url: string, token: string) {
  if (client === "claude-code") {
    return `claude mcp add --transport http hellobox ${url} \\\n  --header "Authorization: Bearer ${token}"`;
  }
  if (client === "claude-desktop") {
    return JSON.stringify(
      { mcpServers: { hellobox: { command: "npx", args: ["-y", "mcp-remote", url, "--header", `Authorization: Bearer ${token}`] } } },
      null,
      2,
    );
  }
  return JSON.stringify(
    { mcpServers: { hellobox: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } },
    null,
    2,
  );
}

const AGENT_SETUP_HINTS: Record<AgentClient, string> = {
  "claude-code": "Run this in a terminal. Add --scope user to use it in every project.",
  "claude-desktop": "Add this to claude_desktop_config.json under Settings, Developer, Edit config, then restart Claude.",
  other: "Most MCP clients, including Cursor and VS Code, take a remote server with a URL and headers like this.",
};

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

function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2000);
        } catch (error) {
          notifyError(error);
        }
      }}
    >
      {copied ? <Check /> : <Copy />}
      {copied ? "Copied" : label}
    </Button>
  );
}

function AgentSetup({ token }: { token: string }) {
  const [client, setClient] = useState<AgentClient>("claude-code");
  // Only shown after creating a connection, so this never renders on the server.
  const url = `${window.location.origin}/api/mcp`;
  const snippet = agentSetup(client, url, token);
  return (
    <div className="space-y-3">
      <Segmented label="MCP client" value={client} onChange={setClient} options={AGENT_CLIENTS} />
      <p className="text-muted-foreground text-sm">{AGENT_SETUP_HINTS[client]}</p>
      <pre className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs leading-relaxed">{snippet}</pre>
      <div className="flex flex-wrap gap-2">
        <CopyButton value={snippet} />
        <CopyButton value={url} label="Copy server URL" />
      </div>
    </div>
  );
}

function AgentsTab({ data }: { data: Bootstrap }) {
  const run = useRun();
  const [connections, setConnections] = useState<AgentConnection[] | null>(null);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<AgentScope[]>(["read", "write"]);
  const [days, setDays] = useState("90");
  const [created, setCreated] = useState<NewAgentConnection | null>(null);
  const load = useCallback(
    () => call("/agents/list").then(setConnections).catch((error: unknown) => notifyError(error)),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);
  const effective = normalizeScopes(scopes);
  const toggle = (scope: AgentScope, on: boolean) =>
    setScopes((current) => (on ? [...current, scope] : current.filter((item) => item !== scope)));

  return (
    <div className="space-y-4">
      <Section
        title="Agents"
        description={`Let AI agents like Claude use HelloBox for you over MCP. They act as you in ${data.workspace.name}, with your role and mailboxes and nothing more, and what they change shows up in the audit log.`}
      >
        {!connections ? (
          <Skeleton className="h-16 w-full rounded-xl" />
        ) : connections.length === 0 ? (
          <Empty className="py-6">
            <EmptyHeader>
              <EmptyMedia variant="icon"><Robot /></EmptyMedia>
              <EmptyTitle>No agents connected</EmptyTitle>
              <EmptyDescription>Create a connection below, then paste it into Claude or another MCP client.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="divide-y">
            {connections.map((connection) => (
              <li key={connection.id} className="flex flex-col gap-2 py-3 text-sm sm:flex-row sm:items-center sm:gap-x-3">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 font-medium text-foreground">
                    <span className="truncate">{connection.name}</span>
                    <code className="font-mono text-muted-foreground text-xs">…{connection.hint}</code>
                  </p>
                  <p className="text-muted-foreground text-xs tabular-nums">
                    {connection.lastUsedAt ? `Last used ${formatDay(connection.lastUsedAt)}` : "Never used"} · Expires {formatDay(connection.expiresAt)}
                  </p>
                </div>
                <div className="flex items-center justify-between gap-2">
                <div className="flex flex-wrap gap-1">
                  {connection.scopes.map((scope) => <Badge key={scope} variant="secondary" className="capitalize">{scope}</Badge>)}
                </div>
                <AlertDialog>
                  <AlertDialogTrigger render={<Button size="sm" variant="ghost" />}>Revoke</AlertDialogTrigger>
                  <AlertDialogPopup>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Revoke {connection.name}?</AlertDialogTitle>
                      <AlertDialogDescription>Anything using this connection loses access right away. Emails it already queued still send unless you cancel them.</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogClose render={<Button variant="ghost" />}>Keep it</AlertDialogClose>
                      <AlertDialogClose
                        render={<Button variant="destructive" />}
                        onClick={async () => {
                          if (await run(() => call("/agents/revoke", { id: connection.id }), "Connection revoked")) load();
                        }}
                      >
                        Revoke
                      </AlertDialogClose>
                    </AlertDialogFooter>
                  </AlertDialogPopup>
                </AlertDialog>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="New connection" description="You'll see the token once. Store it in your MCP client, not anywhere shared.">
        <Form
          className="space-y-4"
          onSubmit={async (event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            await run(async () => {
              const result = await call("/agents/create", {
                name,
                scopes: effective,
                days: Number(days) as (typeof AGENT_TOKEN_LIFETIMES)[number],
              });
              setCreated(result);
              setName("");
              load();
            });
          }}
        >
          <Field>
            <FieldLabel>Name</FieldLabel>
            <Input required maxLength={60} placeholder="Claude on my laptop" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <fieldset className="space-y-2">
            <legend className="mb-2 font-medium text-foreground text-sm">What it can do</legend>
            {AGENT_SCOPES.map((scope) => (
              <Label key={scope} className="flex items-start gap-2 font-normal">
                <Checkbox
                  className="mt-0.5"
                  checked={effective.includes(scope)}
                  disabled={scope === "read" || (scope === "write" && effective.includes("send"))}
                  onCheckedChange={(checked) => toggle(scope, Boolean(checked))}
                />
                <span>
                  <span className="font-medium text-foreground capitalize">{scope}</span>
                  <span className="block text-muted-foreground text-xs">{AGENT_SCOPE_LABELS[scope]}</span>
                </span>
              </Label>
            ))}
          </fieldset>
          <Field>
            <FieldLabel>Expires after</FieldLabel>
            <Select value={days} onValueChange={(value) => { if (value) setDays(value); }} items={LIFETIMES}>
              <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
              <SelectPopup>{LIFETIMES.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectPopup>
            </Select>
          </Field>
          <Button type="submit"><Plugs /> Create connection</Button>
        </Form>
      </Section>

      <Dialog open={created !== null} onOpenChange={(open) => { if (!open) setCreated(null); }}>
        <DialogPopup className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Connect {created?.name}</DialogTitle>
            <DialogDescription>Copy the token now. You won&apos;t be able to see it again.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-lg bg-muted p-2 font-mono text-xs">{created?.token}</code>
              {created && <CopyButton value={created.token} />}
            </div>
            {created && <AgentSetup token={created.token} />}
          </DialogPanel>
          <DialogFooter>
            <Button onClick={() => setCreated(null)}>Done</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

const TABS = [
  { value: "account", label: "Account", icon: <UserCircle /> },
  { value: "connection", label: "Domains", icon: <Globe /> },
  { value: "mailboxes", label: "Mailboxes", icon: <Tray /> },
  { value: "team", label: "Team", icon: <UsersThree /> },
  { value: "notifications", label: "Notifications", icon: <BellRinging /> },
  { value: "encryption", label: "Encryption", icon: <LockKey /> },
  { value: "rules", label: "Rules", icon: <ListChecks /> },
  { value: "suppressions", label: "Suppressed", icon: <Prohibit /> },
  { value: "ai", label: "AI", icon: <Sparkle /> },
  { value: "agents", label: "Agents", icon: <Robot /> },
  { value: "feedback", label: "Feedback", icon: <ChatCircleText /> },
];

// The open tabs with the cloud build's added after the one each names.
const cloudTabs = clientExtensions.settingsTabs ?? [];
const ALL_TABS = [
  ...TABS.flatMap((tab) => [tab, ...cloudTabs.filter((extra) => extra.after === tab.value)]),
  ...cloudTabs.filter((extra) => !TABS.some((tab) => tab.value === extra.after)),
];

function Settings() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const requested = useSearchParam("tab");
  const [chosenTab, setTab] = useState<string | null>(null);
  const tab = chosenTab ?? (ALL_TABS.some((item) => item.value === requested) ? (requested as string) : "account");
  const refresh = useCallback(() => {
    call("/app/bootstrap")
      .then(setData)
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 401) window.location.href = "/login";
      });
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  useEntitlementsChanged(refresh);

  return (
    <main className="min-h-dvh bg-canvas px-4 py-6">
      <div className="mx-auto max-w-4xl">
        <Button variant="ghost" size="sm" className="mb-4 -ms-2" render={<Link href="/inbox" />}><ArrowLeft /> Back to inbox</Button>
        <div className="mb-6 flex items-center gap-3">
          <Logo size={36} />
          <h1 className="font-heading font-semibold text-2xl text-foreground tracking-tight">Settings</h1>
        </div>
        {!data ? (
          <div className="space-y-4"><Skeleton className="h-9 w-full max-w-lg" /><Skeleton className="h-64 w-full rounded-2xl" /></div>
        ) : (
          <Tabs value={tab} onValueChange={(value) => setTab(String(value))}>
            {/* Scrolls sideways on phones; centering an overflowing row would cut off its start. */}
            <div className="-mx-4 mb-4 overflow-x-auto px-4 [scrollbar-width:none]">
              <TabsList className="w-max justify-start *:shrink-0">
                {ALL_TABS.map((item) => <TabsTab key={item.value} value={item.value}>{item.icon} {item.label}</TabsTab>)}
              </TabsList>
            </div>
            <TabsPanel value="account"><AccountTab data={data} refresh={refresh} /></TabsPanel>
            <TabsPanel value="connection"><ConnectionTab data={data} refresh={refresh} /></TabsPanel>
            <TabsPanel value="mailboxes"><MailboxesTab data={data} refresh={refresh} /></TabsPanel>
            <TabsPanel value="team"><TeamTab data={data} refresh={refresh} /></TabsPanel>
            <TabsPanel value="notifications"><NotificationsTab data={data} /></TabsPanel>
            <TabsPanel value="encryption"><EncryptionTab /></TabsPanel>
            <TabsPanel value="rules"><RulesTab admin={data.role !== "member"} /></TabsPanel>
            <TabsPanel value="suppressions"><SuppressionsTab admin={data.role !== "member"} /></TabsPanel>
            <TabsPanel value="ai"><AiTab /></TabsPanel>
            <TabsPanel value="agents"><AgentsTab data={data} /></TabsPanel>
            <TabsPanel value="feedback">
              <Section title="Feedback and contact" description="Ideas, bugs or questions go straight to the people who build HelloBox. We reply to your account email.">
                <FeedbackContent className="max-w-xl" />
              </Section>
            </TabsPanel>
            {cloudTabs.map(({ value, Panel }) => <TabsPanel key={value} value={value}><Panel data={data} refresh={refresh} /></TabsPanel>)}
          </Tabs>
        )}
      </div>
    </main>
  );
}

export function SettingsApp() {
  return (
    <AppProviders>
      <Settings />
    </AppProviders>
  );
}
