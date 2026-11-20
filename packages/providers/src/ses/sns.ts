import { createVerify } from "node:crypto";

export interface SnsMessage {
  Type: "Notification" | "SubscriptionConfirmation" | "UnsubscribeConfirmation";
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: "1" | "2";
  Signature: string;
  SigningCertURL: string;
  Subject?: string;
  Token?: string;
  SubscribeURL?: string;
}

export class SnsVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnsVerificationError";
  }
}

// Only certificates served by SNS itself can sign a message.
const CERT_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;
const MAX_AGE_MS = 60 * 60 * 1000;

const certCache = new Map<string, string>();

async function fetchCert(url: string) {
  const cached = certCache.get(url);
  if (cached) return cached;
  const res = await fetch(url);
  if (!res.ok) throw new SnsVerificationError(`Couldn't fetch the signing certificate (${res.status})`);
  const pem = await res.text();
  certCache.set(url, pem);
  return pem;
}

const FIELDS = {
  Notification: ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"],
  SubscriptionConfirmation: ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"],
  UnsubscribeConfirmation: ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"],
} as const;

// The exact string SNS signs: each present field's name and value on their own lines.
export function stringToSign(message: SnsMessage) {
  const fields = FIELDS[message.Type];
  if (!fields) throw new SnsVerificationError(`Unknown message type ${message.Type}`);
  let out = "";
  for (const field of fields) {
    const value = message[field as keyof SnsMessage];
    if (value === undefined) continue;
    out += `${field}\n${value}\n`;
  }
  return out;
}

export async function verifySnsMessage(
  body: unknown,
  options: { fetchCertificate?: (url: string) => Promise<string>; now?: Date } = {},
): Promise<SnsMessage> {
  const message = body as SnsMessage;
  if (!message || typeof message !== "object" || typeof message.Signature !== "string") {
    throw new SnsVerificationError("Not an SNS message");
  }
  let certUrl: URL;
  try {
    certUrl = new URL(message.SigningCertURL);
  } catch {
    throw new SnsVerificationError("Bad signing certificate URL");
  }
  if (certUrl.protocol !== "https:" || !CERT_HOST.test(certUrl.hostname) || !certUrl.pathname.endsWith(".pem")) {
    throw new SnsVerificationError("The signing certificate isn't from SNS");
  }
  const sentAt = Date.parse(message.Timestamp);
  const now = (options.now ?? new Date()).getTime();
  if (Number.isNaN(sentAt) || Math.abs(now - sentAt) > MAX_AGE_MS) {
    throw new SnsVerificationError("The message is too old");
  }
  const algorithm = message.SignatureVersion === "2" ? "RSA-SHA256" : message.SignatureVersion === "1" ? "RSA-SHA1" : null;
  if (!algorithm) throw new SnsVerificationError("Unsupported signature version");
  const pem = await (options.fetchCertificate ?? fetchCert)(certUrl.toString());
  const verifier = createVerify(algorithm);
  verifier.update(stringToSign(message), "utf8");
  if (!verifier.verify(pem, message.Signature, "base64")) {
    throw new SnsVerificationError("Invalid signature");
  }
  return message;
}

// Subscribing to our endpoint has to be confirmed by visiting the URL SNS sends.
export async function confirmSubscription(message: SnsMessage) {
  if (!message.SubscribeURL) throw new SnsVerificationError("No subscribe URL");
  const url = new URL(message.SubscribeURL);
  if (url.protocol !== "https:" || !CERT_HOST.test(url.hostname)) {
    throw new SnsVerificationError("The subscribe URL isn't from SNS");
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Confirming the SNS subscription failed (${res.status})`);
}
