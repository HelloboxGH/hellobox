import type { CustomSpec } from "./spec";

// Worked examples: in the AI prompt, and as tests that the formats cover real APIs' shapes.
// Each follows the provider's public API docs; HelloBox has its own integration for these,
// so they're only examples.

// A JSON body with nested recipients, like SendGrid's v3 mail/send.
export const JSON_EXAMPLE: CustomSpec = {
  version: 1,
  name: "SendGrid-style JSON",
  send: {
    method: "POST",
    url: "https://api.sendgrid.com/v3/mail/send",
    headers: { Authorization: "Bearer <API_KEY>" },
    body: {
      type: "json",
      content: {
        personalizations: [{ to: "{{to | objects email name}}", cc: "{{cc | objects email name}}", bcc: "{{bcc | objects email name}}" }],
        from: "{{from | object email name}}",
        reply_to_list: "{{replyTo | objects email name}}",
        subject: "{{subject}}",
        content: [
          { type: "text/plain", value: "{{text}}" },
          { type: "text/html", value: "{{html}}" },
        ],
        headers: "{{headers | map}}",
        attachments: "{{attachments | objects content filename contentType=type contentId=content_id}}",
      },
    },
    response: { id: "header:X-Message-Id" },
  },
  events: {
    verify: { type: "token", header: "X-Webhook-Token", secret: "<WEBHOOK_TOKEN>" },
    type: "event",
    map: { delivered: "delivered", bounce: "bounced", spamreport: "complained", deferred: "delayed", dropped: "failed" },
    id: "sg_message_id",
    recipient: "email",
    reason: "reason",
  },
};

// A form body with Basic sign-in, like Mailgun's messages endpoint.
export const FORM_EXAMPLE: CustomSpec = {
  version: 1,
  name: "Mailgun-style form",
  send: {
    method: "POST",
    url: "https://api.mailgun.net/v3/<DOMAIN>/messages",
    headers: {},
    auth: { type: "basic", username: "api", password: "<API_KEY>" },
    body: {
      type: "form",
      content: {
        from: "{{from}}",
        to: "{{to}}",
        cc: "{{cc}}",
        bcc: "{{bcc}}",
        subject: "{{subject}}",
        text: "{{text}}",
        html: "{{html}}",
        "h:Reply-To": "{{replyTo | csv}}",
        "h:Message-Id": "{{messageId}}",
      },
    },
    response: { id: "id" },
  },
};

// The same with attachments, which need multipart: each one becomes a file part.
export const MULTIPART_EXAMPLE: CustomSpec = {
  ...FORM_EXAMPLE,
  name: "Mailgun-style multipart",
  send: {
    ...FORM_EXAMPLE.send,
    body: {
      type: "multipart",
      content: { ...(FORM_EXAMPLE.send.body!.content as Record<string, unknown>), attachment: "{{attachments}}" },
    },
  },
};

// The whole message as base64, for APIs that take raw MIME, like Amazon SES's v2 "Raw".
export const RAW_EXAMPLE: CustomSpec = {
  version: 1,
  name: "Raw MIME",
  send: {
    method: "POST",
    url: "https://api.example.com/v1/raw",
    headers: { "X-Api-Key": "<API_KEY>" },
    body: { type: "json", content: { raw: "{{mime | base64}}", to: "{{to | emails}}", cc: "{{cc | emails}}", bcc: "{{bcc | emails}}" } },
  },
};

export const EXAMPLE_SPECS = [JSON_EXAMPLE, FORM_EXAMPLE, MULTIPART_EXAMPLE, RAW_EXAMPLE];
