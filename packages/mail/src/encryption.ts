import { getDb, mailboxes, vaults } from "@hellobox/db";
import { eq } from "drizzle-orm";
import { seal, type SealedContent } from "./vault";

export type SealingKey = { keyId: string; publicKey: string };

// Who stored mail for this mailbox is sealed to, or null when it's stored in the clear.
// Only a personal mailbox whose owner has a vault can be encrypted.
export async function sealingKeysFor(mailbox: {
  encrypted: boolean;
  personalUserId: string | null;
}): Promise<SealingKey[] | null> {
  if (!mailbox.encrypted || !mailbox.personalUserId) return null;
  const [vault] = await getDb()
    .select({ keyId: vaults.keyId, publicKey: vaults.publicKey })
    .from(vaults)
    .where(eq(vaults.userId, mailbox.personalUserId));
  // A mailbox marked encrypted without a key would mean storing mail nobody can read.
  // Store it in the clear rather than lose it; turning on encryption requires a vault.
  return vault ? [vault] : null;
}

export async function sealingKeysForMailbox(mailboxId: string) {
  const [mailbox] = await getDb()
    .select({ encrypted: mailboxes.encrypted, personalUserId: mailboxes.personalUserId })
    .from(mailboxes)
    .where(eq(mailboxes.id, mailboxId));
  return mailbox ? sealingKeysFor(mailbox) : null;
}

// The columns a message row gets: the bodies sealed, and nothing readable left beside them.
export async function bodyColumns(content: SealedContent, keys: SealingKey[] | null) {
  if (!keys) return { textBody: content.text, htmlBody: content.html, sealedBody: null };
  return { textBody: null, htmlBody: null, sealedBody: await seal(content, keys) };
}
