"use client";

import { ArrowLeft, Tray } from "@phosphor-icons/react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { AccentPicker } from "@/components/accent-picker";
import { Logo } from "@/components/brand";
import { SenderAvatar } from "@/components/mail/sender-avatar";
import { ProfilePhoto } from "@/components/profile-photo";
import { NotificationsTab } from "@/components/settings/notifications-tab";
import { ImportPanel } from "@/components/mail/import-panel";
import { isUploading } from "@/core/client/imports";
import { WorkspaceLogoPicker, WorkspaceMark } from "@/components/workspace-logo";
import { AppProviders } from "@/components/providers";
import { Segmented } from "@/components/segmented";
import { setTheme, type ThemeMode, useTheme } from "@/components/theme";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, type Bootstrap, call } from "@/core/client/api";
import { authClient } from "@/core/client/auth-client";
import { notifyError } from "@/core/client/notify";
import { cn } from "@/lib/utils";

type StepId = "profile" | "appearance" | "workspace" | "import" | "notifications";

const STEP_COPY: Record<StepId, { title: string; description: string }> = {
  profile: { title: "Set up your profile", description: "This is how you appear in HelloBox." },
  appearance: { title: "Make it yours", description: "Pick how HelloBox looks on this device. You can change it any time." },
  workspace: { title: "Name your workspace", description: "Its name and logo are what your team sees when they switch workspaces." },
  import: {
    title: "Bring your old mail",
    description: "Import mail from Gmail, Apple Mail, Thunderbird or any app that exports MBOX or EML. It works before your domain is set up, and you can skip this and do it later from the account menu.",
  },
  notifications: {
    title: "Hear about new mail",
    description: "Pick where we tell you when mail arrives. Add as many as you like, or skip this and do it later in Settings.",
  },
};

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

// Theme and accent apply as they're picked, so this shows the real result.
function Preview({ name, image, workspace, logo }: { name: string; image: string | null; workspace: string; logo: string | null }) {
  return (
    <div aria-hidden="true" className="flex h-80 w-full max-w-md overflow-hidden rounded-2xl border bg-canvas p-2 shadow-sm">
      <div className="flex w-32 shrink-0 flex-col gap-2 p-2">
        <p className="flex min-w-0 items-center gap-1.5 font-semibold text-foreground text-xs">
          <WorkspaceMark name={workspace || "Workspace"} logo={logo} className="size-5 rounded-md text-[0.5rem]" />
          <span className="truncate">{workspace}</span>
        </p>
        <div className="rounded-md bg-primary px-2 py-1 font-medium text-primary-foreground text-xs">Compose</div>
        <div className="flex items-center gap-1.5 rounded-md bg-brand-soft px-2 py-1 text-brand-foreground text-xs"><Tray /> Inbox</div>
        <div className="mt-auto flex items-center gap-1.5">
          <SenderAvatar name={name || "You"} src={image} className="size-6" />
          <span className="truncate text-foreground text-xs">{name || "You"}</span>
        </div>
      </div>
      <div className="flex-1 space-y-3 rounded-xl border bg-background p-3">
        {[64, 88, 72, 80].map((width, index) => (
          <div key={width} className="flex items-center gap-2">
            <span className={cn("size-1.5 shrink-0 rounded-full", index === 0 ? "bg-brand" : "bg-transparent")} />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="h-2 rounded-full bg-foreground/20" style={{ width: `${width}%` }} />
              <div className="h-2 rounded-full bg-muted" style={{ width: `${width - 12}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Only the owner names the workspace: anyone else, admins included, joined one through an
// invite or SSO, and renaming it here would rename someone else's team.
function stepsFor(data: Bootstrap): StepId[] {
  return data.role === "owner"
    ? ["profile", "appearance", "workspace", "import", "notifications"]
    : ["profile", "appearance", "import", "notifications"];
}

function Flow() {
  const theme = useTheme();
  const [data, setData] = useState<Bootstrap | null>(null);
  const [name, setName] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const seeded = useRef(false);

  const load = useCallback(() => {
    call("/app/bootstrap")
      .then((next) => {
        const replaying = new URLSearchParams(window.location.search).has("replay");
        if (next.user.onboardedAt && !replaying) {
          window.location.replace("/inbox");
          return;
        }
        setData(next);
        if (!seeded.current) {
          seeded.current = true;
          // Back from connecting Discord or Slack: resume on the notifications step.
          if (new URLSearchParams(window.location.search).get("step") === "notifications") {
            setIndex(stepsFor(next).indexOf("notifications"));
          }
          setName(next.user.name);
          setWorkspaceName(next.workspace.name);
        }
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 401) window.location.href = "/login";
        else notifyError(error);
      });
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  if (!data) {
    return (
      <div className="mx-auto w-full max-w-md space-y-4 p-6 pt-24">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full rounded-2xl" />
      </div>
    );
  }

  const steps = stepsFor(data);
  const step = steps[index] ?? "profile";
  const last = index === steps.length - 1;
  const copy = STEP_COPY[step];

  async function finish() {
    // Leaving the page stops an upload that's still going.
    if (isUploading() && !window.confirm("An import is still uploading. Leaving now stops it. Leave anyway?")) {
      setBusy(false);
      return;
    }
    await call("/onboarding/complete");
    window.location.href = "/inbox?tour=1";
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!data) return;
    setBusy(true);
    try {
      if (step === "profile" && name.trim() !== data.user.name) {
        const { error } = await authClient.updateUser({ name: name.trim() });
        if (error) throw new Error(error.message ?? "Couldn't save your name");
      }
      if (step === "workspace" && workspaceName.trim() !== data.workspace.name) {
        await call("/workspace/rename", { name: workspaceName.trim() });
      }
      if (last) {
        await finish();
        return;
      }
      setIndex(index + 1);
    } catch (error) {
      notifyError(error);
    }
    setBusy(false);
  }

  async function skip() {
    if (!data) return;
    setBusy(true);
    try {
      // Signup no longer asks for a name, so someone skipping before the profile step
      // would stay nameless: keep what they typed, or the first part of their email.
      if (!data.user.name.trim()) {
        const fallback = name.trim() || data.user.email.split("@")[0] || "";
        if (fallback) await authClient.updateUser({ name: fallback.slice(0, 100) });
      }
      await finish();
    } catch (error) {
      notifyError(error);
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-dvh bg-background lg:grid-cols-2">
      <div className="flex min-w-0 flex-col p-6 sm:p-10">
        <div className="flex items-center justify-between gap-3">
          <Logo size={32} />
          <Button variant="ghost" size="sm" disabled={busy} onClick={skip}>Skip setup</Button>
        </div>
        <div className={cn("mx-auto flex w-full flex-1", step === "notifications" || step === "import" ? "max-w-2xl" : "max-w-md", " flex-col justify-center gap-6 py-10")}>
          <div className="space-y-3">
            <div className="flex gap-1.5" role="img" aria-label={`Step ${index + 1} of ${steps.length}`}>
              {steps.map((item, position) => (
                <span key={item} className={cn("h-1 flex-1 rounded-full", position <= index ? "bg-brand" : "bg-muted")} />
              ))}
            </div>
            <h1 className="font-semibold text-2xl text-foreground tracking-tight">{copy.title}</h1>
            <p className="text-muted-foreground text-sm">{copy.description}</p>
          </div>

          {/* Outside the form: its dialogs have forms of their own, and their submits would bubble up here. */}
          {step === "notifications" && <NotificationsTab data={data} onboarding />}
          {step === "import" && <ImportPanel data={data} onboarding />}
          <Form className="space-y-5" onSubmit={submit}>
            {step === "profile" && (
              <>
                <Field>
                  <FieldLabel>Your name</FieldLabel>
                  <Input autoFocus required maxLength={100} autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} />
                </Field>
                <ProfilePhoto name={name} email={data.user.email} image={data.user.image} onChanged={load} />
              </>
            )}
            {step === "appearance" && (
              <>
                <div className="space-y-2">
                  <p className="font-medium text-foreground text-sm">Theme</p>
                  <Segmented label="Theme" value={theme} onChange={(value: ThemeMode) => setTheme(value)} options={THEME_OPTIONS} />
                </div>
                <div className="space-y-2">
                  <p className="font-medium text-foreground text-sm">Accent</p>
                  <AccentPicker />
                </div>
              </>
            )}
            {step === "workspace" && (
              <Field>
                <FieldLabel>Workspace name</FieldLabel>
                <Input autoFocus required maxLength={80} value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} />
                <FieldDescription>Your company or team name works well.</FieldDescription>
              </Field>
            )}
            {step === "workspace" && (
              <WorkspaceLogoPicker name={workspaceName} logo={data.workspace.logo} onChanged={load} />
            )}
            <div className="flex items-center gap-2 pt-1">
              {index > 0 && (
                <Button type="button" variant="ghost" disabled={busy} onClick={() => setIndex(index - 1)}>
                  <ArrowLeft /> Back
                </Button>
              )}
              <Button type="submit" className="ms-auto" loading={busy}>{last ? "Finish" : "Continue"}</Button>
            </div>
          </Form>
        </div>
      </div>
      <div className="hidden items-center justify-center border-s bg-canvas p-10 lg:flex">
        <Preview name={name} image={data.user.image} workspace={workspaceName} logo={data.workspace.logo} />
      </div>
    </main>
  );
}

export function OnboardingFlow() {
  return (
    <AppProviders>
      <Flow />
    </AppProviders>
  );
}
