import { Webhook } from "svix";

export interface WebhookEvent {
  type: string;
  created_at: string;
  data: { email_id?: string; [key: string]: unknown };
}

// Throws if the signature is invalid.
export function verifyWebhook(
  rawBody: string,
  headers: Headers,
  secret: string,
): WebhookEvent {
  new Webhook(secret).verify(rawBody, {
    "svix-id": headers.get("svix-id") ?? "",
    "svix-timestamp": headers.get("svix-timestamp") ?? "",
    "svix-signature": headers.get("svix-signature") ?? "",
  });
  return JSON.parse(rawBody) as WebhookEvent;
}
