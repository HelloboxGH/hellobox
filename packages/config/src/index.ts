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

const resendOAuthSchema = z.object({
  RESEND_OAUTH_CLIENT_ID: z.string().min(1),
  RESEND_OAUTH_CLIENT_SECRET: z.string().min(1),
});

const cloudflareOAuthSchema = z.object({
  CF_CLIENT_ID: z.string().min(1),
  CF_CLIENT_SECRET: z.string().min(1),
});

const r2Schema = z.object({
  R2_ACCOUNT_ID: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET: z.string().min(1),
});

// The AWS account of whoever runs this instance, which customers' SES roles trust.
const awsBrokerSchema = z.object({
  AWS_BROKER_ACCOUNT_ID: z.string().regex(/^\d{12}$/),
  AWS_BROKER_ACCESS_KEY_ID: z.string().min(1),
  AWS_BROKER_SECRET_ACCESS_KEY: z.string().min(1),
  AWS_BROKER_REGION: z.string().min(1).default("us-east-1"),
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
export const getR2Env = lazy(() => r2Schema.parse(process.env));
export const isR2Configured = () => r2Schema.safeParse(process.env).success;
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

// Platform admins are listed by email in ADMIN_EMAILS. Unset means nobody is an admin.
export function parseAdminEmails(value = process.env.ADMIN_EMAILS) {
  return [...new Set((value ?? "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean))];
}
