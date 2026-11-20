const API = "https://api.resend.com";

export class ResendApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ResendApiError";
  }
}

export interface ResendDomain {
  id: string;
  name: string;
  status: string;
  capabilities?: { sending?: string; receiving?: string };
}

// Names are mostly relative ("send", "resend._domainkey"), sometimes full.
export interface ResendDomainRecord {
  record: string;
  name: string;
  type: string;
  value: string;
  priority?: number;
  status?: string;
}

export interface ResendDomainDetails extends ResendDomain {
  records?: ResendDomainRecord[];
}

type Capability = "enabled" | "disabled";

export interface ReceivedAttachment {
  id: string;
  filename: string;
  content_type: string;
  content_disposition: string | null;
  content_id: string | null;
  size?: number;
  download_url?: string;
}

export interface ReceivedEmail {
  id: string;
  to: string[];
  from: string;
  created_at: string;
  subject: string;
  html: string | null;
  html_format?: "data_uri" | "cid";
  text: string | null;
  headers: Record<string, string | string[]> | null;
  bcc: string[] | null;
  cc: string[] | null;
  reply_to: string[] | null;
  received_for?: string[];
  authentication?: {
    spf?: string;
    dkim?: string;
    dmarc?: string;
  } | null;
  message_id: string | null;
  raw?: { download_url: string; expires_at: string } | null;
  attachments: ReceivedAttachment[];
}

export interface ReceivedEmailSummary {
  id: string;
  to: string[];
  created_at: string;
}

export interface SendEmailInput {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  reply_to?: string[];
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
  attachments?: { filename: string; path: string; content_id?: string }[];
}

export interface ResendContactInput {
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  unsubscribed?: boolean;
  properties?: Record<string, string | null>;
  segments?: { id: string }[];
}

export interface ResendContactSummary {
  id: string;
  email: string;
  unsubscribed: boolean;
}

export interface CreateBroadcastInput {
  segment_id: string;
  from: string;
  subject: string;
  html: string;
  name?: string;
  reply_to?: string[];
}

export type TokenProvider = () => Promise<string>;

const MAX_RATE_LIMIT_RETRIES = 4;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The only place in the app that talks to the Resend API.
export class ResendClient {
  constructor(private readonly token: TokenProvider) {}

  private async request<T>(
    path: string,
    init: RequestInit = {},
    headers: Record<string, string> = {},
    attempt = 0,
  ): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        "Content-Type": "application/json",
        "User-Agent": "hellobox/1.0",
        ...headers,
      },
    });
    // Resend allows a handful of requests per second per team. Contact syncs hit that.
    if (res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
      return this.request<T>(path, init, headers, attempt + 1);
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        message?: string;
      } | null;
      throw new ResendApiError(
        res.status,
        body?.message ?? `Resend request failed with status ${res.status}`,
      );
    }
    return (await res.json().catch(() => ({}))) as T;
  }

  async listDomains() {
    const { data } = await this.request<{ data: ResendDomain[] }>("/domains");
    return data;
  }

  getDomain(id: string) {
    return this.request<ResendDomainDetails>(`/domains/${id}`);
  }

  createDomain(name: string, capabilities: { sending: Capability; receiving: Capability }) {
    return this.request<ResendDomainDetails>("/domains", {
      method: "POST",
      body: JSON.stringify({ name, capabilities }),
    });
  }

  updateDomain(id: string, patch: { capabilities: { receiving: Capability } }) {
    return this.request<{ id: string }>(`/domains/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
  }

  // Resend checks the records in the background and updates the domain's status.
  async verifyDomain(id: string) {
    await this.request(`/domains/${id}/verify`, { method: "POST" });
  }

  createWebhook(endpoint: string, events: string[]) {
    return this.request<{ id: string; signing_secret: string }>("/webhooks", {
      method: "POST",
      body: JSON.stringify({ endpoint, events }),
    });
  }

  async deleteWebhook(id: string) {
    await this.request(`/webhooks/${id}`, { method: "DELETE" });
  }

  listReceived(options: { limit?: number; after?: string } = {}) {
    const query = new URLSearchParams({ limit: String(options.limit ?? 100) });
    if (options.after) query.set("after", options.after);
    return this.request<{
      data: ReceivedEmailSummary[];
      has_more: boolean;
    }>(`/emails/receiving?${query}`);
  }

  getReceived(id: string) {
    // cid keeps inline images out of the stored HTML.
    return this.request<ReceivedEmail>(
      `/emails/receiving/${id}?html_format=cid`,
    );
  }

  async listAttachments(emailId: string) {
    const { data } = await this.request<{ data: ReceivedAttachment[] }>(
      `/emails/receiving/${emailId}/attachments`,
    );
    return data;
  }

  sendEmail(input: SendEmailInput, idempotencyKey: string) {
    return this.request<{ id: string }>(
      "/emails",
      { method: "POST", body: JSON.stringify(input) },
      { "Idempotency-Key": idempotencyKey },
    );
  }

  // Contacts are global to a Resend team, so they're addressed by email and grouped
  // into a Segment per workspace.

  createSegment(name: string) {
    return this.request<{ id: string }>("/segments", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  }

  async listContactPropertyKeys() {
    const keys: string[] = [];
    let after: string | undefined;
    for (;;) {
      const query = new URLSearchParams({ limit: "100" });
      if (after) query.set("after", after);
      const page = await this.request<{ data: { id: string; key: string }[]; has_more: boolean }>(
        `/contact-properties?${query}`,
      );
      keys.push(...page.data.map((property) => property.key));
      if (!page.has_more || !page.data.length) return keys;
      after = page.data[page.data.length - 1]?.id;
    }
  }

  createContactProperty(key: string) {
    return this.request<{ id: string }>("/contact-properties", {
      method: "POST",
      body: JSON.stringify({ key, type: "string" }),
    });
  }

  createContact(input: ResendContactInput) {
    return this.request<{ id: string }>("/contacts", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  updateContact(email: string, input: Omit<ResendContactInput, "email" | "segments">) {
    return this.request<{ id: string }>(`/contacts/${encodeURIComponent(email)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }

  addContactToSegment(email: string, segmentId: string) {
    return this.request<{ id: string }>(
      `/contacts/${encodeURIComponent(email)}/segments/${encodeURIComponent(segmentId)}`,
      { method: "POST" },
    );
  }

  async removeContactFromSegment(email: string, segmentId: string) {
    await this.request(
      `/contacts/${encodeURIComponent(email)}/segments/${encodeURIComponent(segmentId)}`,
      { method: "DELETE" },
    );
  }

  listSegmentContacts(segmentId: string, after?: string) {
    const query = new URLSearchParams({ limit: "100", segment_id: segmentId });
    if (after) query.set("after", after);
    return this.request<{ data: ResendContactSummary[]; has_more: boolean }>(`/contacts?${query}`);
  }

  createBroadcast(input: CreateBroadcastInput) {
    return this.request<{ id: string }>("/broadcasts", {
      method: "POST",
      body: JSON.stringify({ ...input, send: false }),
    });
  }

  getBroadcast(id: string) {
    return this.request<{ id: string; status: string }>(`/broadcasts/${encodeURIComponent(id)}`);
  }

  sendBroadcast(id: string) {
    return this.request<{ id: string }>(`/broadcasts/${encodeURIComponent(id)}/send`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  }
}
