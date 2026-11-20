import type { ComponentType, ReactNode } from "react";
import type { Feature, Limit } from "./types";

// What the sign-in page hands a sign-in method: the page's own state, so a method that
// leaves for another site behaves like the Google and GitHub buttons beside it.
export interface SignInMethodProps {
  next: string;
  disabled: boolean;
  pending: string | null; // the redirecting button pressed, until the page is left
  redirect(key: string, action: () => Promise<{ error?: { message?: string } | null } | void>, fallback?: string): Promise<void>;
  email(): string | null; // what's typed in the email field, trimmed
  fail(message: string | null, focusEmail?: boolean): void; // show or clear the form's error
}

// What the client entry (`@ext/client`) holds. Only components, so it never pulls in
// server code. `Bootstrap` is supplied by apps/web.
export interface ClientExtensions<Bootstrap> {
  settingsTabs?: Array<{
    value: string;
    label: string;
    icon: ReactNode;
    after: string;
    Panel: ComponentType<{ data: Bootstrap; refresh(): void }>;
  }>;
  AppProviders?: ComponentType<{ children: ReactNode }>; // BillingDialogs
  AppBanner?: ComponentType<{ data: Bootstrap }>; // BillingNotice, DemoBanner
  // Where the error page says to write. Without it, it links to the issue tracker.
  supportEmail?: string;
  HomeMenuItem?: ComponentType; // the marketing site's "Home" link in the account menu
  AccountMenuItems?: ComponentType<{ data: Bootstrap }>; // "Upgrade plan"
  // Shown where a limit is reached or a feature is locked. It opens its own upgrade dialog.
  UpgradeHint?: ComponentType<{ data: Bootstrap; reason: Limit | Feature }>;
  SignInMethods?: ComponentType<SignInMethodProps>; // "SSO" button
  // "How did you hear about us?". Rendered again with `submitted` once an email signup went
  // through, to let go of what it saved.
  SignupFields?: ComponentType<{ submitted?: boolean }>;
  // Signs in again through a provider the app doesn't know by name (the workspace's SSO), to
  // confirm a sensitive change.
  reauthSso?(providerId: string, callbackURL: string): Promise<{ error?: { message?: string } | null } | void>;
  // What to do with a server error code, by its code. With a `label` the toast gets a button
  // that calls `run`; with only `run`, it runs at once and no toast shows; with neither, the
  // code is known and gets a plain toast.
  errorActions?: Record<string, { label?: string; run?(details: unknown, message: string): void }>;
  // The feedback form (Settings → Feedback and the account menu's dialog). Without it the app
  // links to the project's public issue tracker instead.
  FeedbackPanel?: ComponentType<{ className?: string; onSent?(): void }>;
  // "Using something else? Tell us": the dialog that collects which provider to add next.
  // Without it the picker links to the issue tracker.
  ProviderRequestDialog?: ComponentType<{
    open: boolean;
    onOpenChange(open: boolean): void;
    source: "landing" | "app";
    signedIn: boolean;
    initialProvider?: string;
  }>;
}
