import { supportConversations, supportMessages } from "@hellobox/db";
import { and, eq } from "drizzle-orm";
import type { StoreTx } from "../store-inbound";
import { supportMessageAdded } from "./read";
import { recordSupportEvent } from "./webhooks";

// Whether an email really came from the address it says. DMARC, or both of the checks it
// builds on when the domain publishes no policy.
export const isAuthenticated = (auth: { spf?: string; dkim?: string; dmarc?: string } | null | undefined) =>
  auth?.dmarc === "pass" || (auth?.dmarc !== "fail" && auth?.spf === "pass" && auth?.dkim === "pass");

// An email that joined a support conversation. The team always sees it, and it reopens a
// solved one. It counts as the customer's when it's really from the address the
// conversation is with, verified or not: a form customer answering our email by email is
// still the customer. Only a verified conversation shows it in their app.
export async function recordSupportEmail(
  tx: StoreTx,
  email: {
    threadId: string;
    messageId: string;
    fromAddress: string;
    authentication: { spf?: string; dkim?: string; dmarc?: string } | null | undefined;
    isSpam: boolean;
  },
) {
  const [conversation] = await tx
    .select()
    .from(supportConversations)
    .where(eq(supportConversations.threadId, email.threadId));
  if (!conversation || email.isSpam) return;
  const reopened = await tx
    .update(supportConversations)
    .set({ status: "open" })
    .where(and(eq(supportConversations.id, conversation.id), eq(supportConversations.status, "solved")))
    .returning({ id: supportConversations.id });
  if (reopened.length) await recordSupportEvent(tx, conversation, "conversation.status_changed", { status: "open" });
  if (email.fromAddress !== conversation.email || !isAuthenticated(email.authentication)) return;
  await tx.insert(supportMessages).values({
    workspaceId: conversation.workspaceId,
    inboxId: conversation.inboxId,
    conversationId: conversation.id,
    messageId: email.messageId,
    source: "email",
  });
  await supportMessageAdded(tx, email.threadId, {
    id: email.messageId, direction: "inbound", fromAddress: email.fromAddress, toRecipients: [], ccRecipients: [], sentAt: new Date(),
  });
}
