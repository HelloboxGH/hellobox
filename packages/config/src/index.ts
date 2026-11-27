import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.url(),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  RSPAMD_URL: z.url(),
  ENCRYPTION_KEY: z.string().min(1),
});

// An empty variable counts as unset, so `S3_ENDPOINT=` in a .env file is fine.
const blankIsUnset = (value: unknown) => (value === "" ? undefined : value);

const resendOAuthSchema = z.object({
  RESEND_OAUTH_CLIENT_ID: z.string().min(1),
  RESEND_OAUTH_CLIENT_SECRET: z.string().min(1),
});

const cloudflareOAuthSchema = z.object({
  CF_CLIENT_ID: z.string().min(1),
  CF_CLIENT_SECRET: z.string().min(1),
});

// Cloudflare R2, the original storage setup. Kept as is so existing servers keep working.
const r2Schema = z.object({
  R2_ACCOUNT_ID: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET: z.string().min(1),
});

// Any S3-compatible storage: MinIO, AWS S3, Backblaze B2, Wasabi, and so on.
const s3Schema = z.object({
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  // Leave unset for AWS S3 itself.
  S3_ENDPOINT: z.preprocess(blankIsUnset, z.url().optional()),
  // The address browsers and providers use for download and upload links, when it differs
  // from the one the server uses (a MinIO container is only "minio:9000" inside Docker).
  S3_PUBLIC_ENDPOINT: z.preprocess(blankIsUnset, z.url().optional()),
  S3_REGION: z.preprocess(blankIsUnset, z.string().min(1).default("us-east-1")),
  // Defaults to true when S3_ENDPOINT is set (MinIO needs it), false for AWS S3.
  S3_FORCE_PATH_STYLE: z.preprocess(blankIsUnset, z.enum(["true", "false"]).optional()),
});

// The AWS account of whoever runs this instance, which customers' SES roles trust.
const awsBrokerSchema = z.object({
  AWS_BROKER_ACCOUNT_ID: z.string().regex(/^\d{12}$/),
  AWS_BROKER_ACCESS_KEY_ID: z.string().min(1),
  AWS_BROKER_SECRET_ACCESS_KEY: z.string().min(1),
  AWS_BROKER_REGION: z.preprocess(blankIsUnset, z.string().min(1).default("us-east-1")),
  AWS_TEMPLATES_BASE_URL: z.url(),
});

export type Env = z.infer<typeof envSchema>;

function lazy<T>(read: () => T) {
  let cached: T | undefined;
  return () => {
    cached ??= read();
    return cached;
  };
}

// Validated on first use so that builds don't need runtime secrets.
export const getEnv = lazy(() => envSchema.parse(process.env));
export const getResendOAuthEnv = lazy(() =>
  resendOAuthSchema.parse(process.env),
);
export const getCloudflareOAuthEnv = lazy(() => cloudflareOAuthSchema.parse(process.env));
export const isCloudflareConfigured = () => cloudflareOAuthSchema.safeParse(process.env).success;

export type StorageEnv = {
  // Which settings these came from. R2's signed links are left exactly as they have always been.
  kind: "r2" | "s3";
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  // Where the server talks to storage. Undefined means AWS S3 itself.
  endpoint?: string;
  // Where browsers and providers fetch signed links. Defaults to endpoint.
  publicEndpoint?: string;
  forcePathStyle: boolean;
};

// Complete S3_* settings win; otherwise the R2_* variables, as before.
export const getStorageEnv = lazy((): StorageEnv => {
  const s3 = s3Schema.safeParse(process.env);
  if (s3.success) {
    const env = s3.data;
    return {
      kind: "s3",
      bucket: env.S3_BUCKET,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      publicEndpoint: env.S3_PUBLIC_ENDPOINT,
      forcePathStyle: env.S3_FORCE_PATH_STYLE ? env.S3_FORCE_PATH_STYLE === "true" : Boolean(env.S3_ENDPOINT),
    };
  }
  const r2 = r2Schema.safeParse(process.env);
  if (!r2.success) {
    throw new Error("Object storage isn't set up. Set S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY (or the R2_* variables).");
  }
  const env = r2.data;
  return {
    kind: "r2",
    bucket: env.R2_BUCKET,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    region: "auto",
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    forcePathStyle: false,
  };
});
export const isStorageConfigured = () =>
  s3Schema.safeParse(process.env).success || r2Schema.safeParse(process.env).success;
// The creators app asks this too.
export const isR2Configured = isStorageConfigured;
export const getAwsBrokerEnv = lazy(() => awsBrokerSchema.parse(process.env));
export const isAwsBrokerConfigured = () => awsBrokerSchema.safeParse(process.env).success;

function encryptionKey() {
  const key = Buffer.from(getEnv().ENCRYPTION_KEY, "base64");
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY must be 32 bytes, base64 encoded");
  }
  return key;
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data]
    .map((part) => part.toString("base64url"))
    .join(".");
}

export function decrypt(sealed: string): string {
  const [iv, tag, data] = sealed.split(".");
  if (!iv || !tag || !data) throw new Error("Malformed encrypted value");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(data, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * A reader for a fixed list of settings. This package is the only place that reads
 * process.env (lint enforces it), so every setting the code reads has a name in a list. An
 * empty value counts as unset. Values are read on each call, never cached, so tests can
 * change them.
 */
export function defineSettings<const Name extends string>(names: readonly Name[]) {
  const known = new Set<string>(names);
  return (name: Name): string | undefined => {
    if (!known.has(name)) throw new Error(`${name} isn't a known setting`);
    const value = process.env[name];
    return value === "" ? undefined : value;
  };
}

/** Optional settings the open code reads. Required ones are validated by getEnv() above. */
export const SETTINGS = [
  "APP_URL",
  "DATABASE_URL",
  "REDIS_URL",
  "HELLOBOX_CLOUD",
  "ADMIN_EMAILS",
  "ADMIN_DIGEST_TIMEZONE",
  "ALLOW_SIGNUPS",
  "SUPPORT_EMAIL",
  "BETTER_AUTH_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "SMTP_URL",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "REPLY_TO_DOMAIN",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_BOT_USERNAME",
  "TELEGRAM_WEBHOOK_SECRET",
  "VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  "VAPID_SUBJECT",
  "NTFY_URL",
  "NTFY_TOKEN",
  "DISCORD_CLIENT_ID",
  "DISCORD_CLIENT_SECRET",
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "TURNSTILE_SITE_KEY",
  "TURNSTILE_SECRET_KEY",
  // Shared with the mail server (apps/mx), which signs what it sends us. Used for nothing else.
  "MX_SIGNING_KEY",
  // The mail server's name, which receiving domains point their MX record at.
  "MX_HOSTNAME",
] as const;
export type Setting = (typeof SETTINGS)[number];
export const setting = defineSettings(SETTINGS);

/** Production mode. Browser code reads process.env.NODE_ENV itself: Next.js inlines it. */
export const isProduction = () => process.env.NODE_ENV === "production";
export const isDevelopment = () => process.env.NODE_ENV === "development";

// Platform admins are listed by email in ADMIN_EMAILS. Unset means nobody is an admin.
export function parseAdminEmails(value = setting("ADMIN_EMAILS")) {
  return [...new Set((value ?? "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean))];
}
