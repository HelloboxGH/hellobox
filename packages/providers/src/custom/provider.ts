import { readObject } from "@hellobox/storage";
import { buildRawEmail } from "../mime";
import type { MailProvider, OutgoingMessage, ProviderDomain, SentMessage } from "../types";
import { buildRequest, maskSecrets, readPath, type CustomHttp, type CustomResponse } from "./request";
import { messagePlaceholders, type CustomSpec } from "./spec";
import { EMPTY_MESSAGE, type TemplateAttachment, type TemplateMessage } from "./template";

// A provider the customer described in a spec. It only sends: its domains receive with
// HelloBox.

// The provider refused the customer's values. Reconnecting fixes it; retrying doesn't.
export class CustomAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomAuthError";
  }
}

// Anything else the provider answered, worded for the person who wrote the spec.
export class CustomError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "CustomError";
  }
}

export const isCustomAuthError = (error: unknown) => error instanceof CustomAuthError;

export interface CustomTarget {
  spec: CustomSpec;
  // The <NAME> values.
  secrets: Record<string, string>;
  // The domains the customer typed, when the spec has no domains request.
  domains: string[];
}

const parseJson = (text: string) => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

// Short enough to show; the provider's answer, never what we sent.
const answer = (response: CustomResponse, secrets: Record<string, string>) =>
  maskSecrets(response.body.trim().slice(0, 500), secrets) || "no body";

export function customResponseError(response: CustomResponse, secrets: Record<string, string>): Error {
  const text = `The provider answered ${response.status}: ${answer(response, secrets)}`;
  if (response.status === 401 || response.status === 403) return new CustomAuthError(text);
  return new CustomError(text, response.status);
}

const asArray = (value: unknown) => (Array.isArray(value) ? value : []);

export class CustomProvider implements MailProvider {
  readonly kind = "custom" as const;
  readonly capabilities: MailProvider["capabilities"];

  constructor(
    readonly target: CustomTarget,
    private readonly http: CustomHttp,
    // Tests pass their own files.
    private readonly readFile: (key: string) => Promise<Uint8Array> = async (key) =>
      new Uint8Array(await new Response(await readObject(key)).arrayBuffer()),
  ) {
    this.capabilities = { receiving: false, backfill: false, refreshDomains: Boolean(target.spec.domains) };
  }

  private async request(spec: Parameters<typeof buildRequest>[0], message: TemplateMessage) {
    const request = await buildRequest(spec, { secrets: this.target.secrets, message });
    const response = await this.http(request);
    if (response.status < 200 || response.status >= 300) throw customResponseError(response, this.target.secrets);
    return response;
  }

  // From the provider when the spec can list them, otherwise the ones typed. Typed ones are
  // ready at once, as with SMTP: HelloBox checks the domain is theirs before receiving.
  async listDomains(): Promise<ProviderDomain[]> {
    const spec = this.target.spec.domains;
    if (!spec) return this.target.domains.map((name) => ({ id: name, name, status: "verified", sending: true, receiving: false }));
    const response = await this.request(spec, EMPTY_MESSAGE);
    const json = parseJson(response.body);
    const items = asArray(readPath({ json }, spec.list));
    return items.flatMap((item) => {
      const name = readPath({ json: item }, spec.name);
      if (typeof name !== "string" || !name) return [];
      const verified = spec.verified ? readPath({ json: item }, spec.verified.path) === spec.verified.equals : true;
      const domain = name.toLowerCase();
      return [{ id: domain, name: domain, status: verified ? "verified" : "pending", sending: verified, receiving: false }];
    });
  }

  async templateMessage(message: OutgoingMessage, idempotencyKey: string): Promise<TemplateMessage> {
    const fields = new Set(messagePlaceholders(this.target.spec.send).map(({ field }) => field));
    const files = await Promise.all(
      (message.attachments ?? []).map(async (file) => ({ ...file, bytes: await this.readFile(file.storageKey) })),
    );
    const attachments: TemplateAttachment[] = files.map((file) => ({
      filename: file.filename,
      contentType: file.contentType,
      content: Buffer.from(file.bytes).toString("base64"),
      ...(file.contentId ? { contentId: file.contentId } : {}),
    }));
    const mime = fields.has("mime")
      ? Buffer.from(await buildRawEmail(message, files.map((file) => ({ ...file, content: file.bytes })))).toString("utf8")
      : "";
    return {
      from: message.from,
      to: message.to,
      cc: message.cc ?? [],
      bcc: message.bcc ?? [],
      replyTo: message.replyTo ?? [],
      subject: message.subject,
      html: message.html,
      text: message.text ?? "",
      headers: message.headers ?? {},
      attachments,
      tags: message.tags ?? {},
      idempotencyKey,
      messageId: message.headers?.["Message-ID"] ?? "",
      mime,
    };
  }

  // The id is read from the answer where the spec says, otherwise it's our Message-ID,
  // which delivery events can then be matched on.
  async send(message: OutgoingMessage, idempotencyKey: string): Promise<SentMessage> {
    const filled = await this.templateMessage(message, idempotencyKey);
    const response = await this.request(this.target.spec.send, filled);
    const path = this.target.spec.send.response?.id;
    const found = path ? readPath({ headers: response.headers, json: parseJson(response.body) }, path) : undefined;
    const id = typeof found === "string" || typeof found === "number" ? String(found) : filled.messageId || crypto.randomUUID();
    return { id: id.replace(/^<|>$/g, "") };
  }
}
