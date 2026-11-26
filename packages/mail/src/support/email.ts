import { supportConversations, supportMessages } from "@hellobox/db";
import { and, eq } from "drizzle-orm";
import type { StoreTx } from "../store-inbound";

// Whether an email really came from the address it says. DMARC, or both of the checks it
// builds on when the domain publishes no policy.
export const isAuthenticated = (auth: { spf?: string; dkim?: string; dmarc?: string } | null | undefined) =>
  auth?.dmarc === "pass" || (auth?.dmarc !== "fail" && auth?.spf === "pass" && auth?.dkim === "pass");

// An email that joined a support conversation. The team always sees it, and it reopens a
// solved one. It counts as the customer's, and so shows up in their app, only when it's
// really from them.
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
  await tx
    .update(supportConversations)
    .set({ status: "open" })
    .where(and(eq(supportConversations.id, conversation.id), eq(supportConversations.status, "solved")));
  if (!conversation.verified || email.fromAddress !== conversation.email || !isAuthenticated(email.authentication)) return;
  await tx.insert(supportMessages).values({
    workspaceId: conversation.workspaceId,
    inboxId: conversation.inboxId,
    conversationId: conversation.id,
    messageId: email.messageId,
    source: "email",
  });
}
