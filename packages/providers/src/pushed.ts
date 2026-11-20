import { deleteObject, inboundKey, listKeys, readObject } from "@hellobox/storage";
import { parseRawEmail } from "./mime";
import type { InboundEmail, InboundHint } from "./types";

// Provider ids become storage keys and job ids, so anything unusual is replaced.
export const safeInboundId = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200);

const isMissing = (error: unknown) => {
  const name = (error as { name?: string } | null)?.name;
  return name === "NoSuchKey" || name === "NotFound";
};

// Our copy of mail that a provider pushed to us. The webhook stores it before answering,
// and ingest reads it like SES mail from S3. Whatever is still here wasn't ingested yet,
// so listing it is the backfill.
export class StoredInbound {
  constructor(
    readonly workspaceId: string,
    readonly connectionId: string,
  ) {}

  key(id: string) {
    return inboundKey(this.workspaceId, this.connectionId, safeInboundId(id));
  }

  private get prefix() {
    return inboundKey(this.workspaceId, this.connectionId, "").replace(/\.eml$/, "");
  }

  // Null when we have no copy, so a provider that also keeps one can fetch it instead.
  async read(id: string, hint: InboundHint = {}): Promise<InboundEmail | null> {
    try {
      const raw = new Uint8Array(await new Response(await readObject(this.key(id))).arrayBuffer());
      return parseRawEmail(id, raw, hint);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async list(next?: string) {
    const page = await listKeys(this.prefix, next);
    const ids = page.keys.map((key) => key.slice(this.prefix.length).replace(/\.eml$/, "")).filter(Boolean);
    return { ids, next: page.next };
  }

  async remove(id: string) {
    await deleteObject(this.key(id));
  }
}
