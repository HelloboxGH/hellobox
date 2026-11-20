import { createHmac, timingSafeEqual } from "node:crypto";
import { getEnv } from "@hellobox/config";
import { contacts, getDb } from "@hellobox/db";
import { eq } from "drizzle-orm";

// Unsubscribe links for providers that don't host their own. The token is the contact
// id plus a signature, so a link can't be guessed or pointed at someone else.

function signature(contactId: string) {
  return createHmac("sha256", Buffer.from(getEnv().ENCRYPTION_KEY, "base64"))
    .update(`unsubscribe:${contactId}`)
    .digest("base64url")
    .slice(0, 32);
}

export const unsubscribeToken = (contactId: string) => `${contactId}.${signature(contactId)}`;

export function contactFromUnsubscribeToken(token: string) {
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const contactId = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(signature(contactId));
  return given.length === expected.length && timingSafeEqual(given, expected) ? contactId : null;
}

const appUrl = () => getEnv().APP_URL.replace(/\/$/, "");

// The page people land on from the footer link. It asks before unsubscribing, because
// link scanners open every URL in an email.
export const unsubscribeUrl = (contactId: string) => `${appUrl()}/unsubscribe/${unsubscribeToken(contactId)}`;

// For the List-Unsubscribe header. Mail apps POST here when someone presses their
// built-in Unsubscribe button (RFC 8058).
export const oneClickUnsubscribeUrl = (contactId: string) =>
  `${appUrl()}/api/unsubscribe/${unsubscribeToken(contactId)}`;

// One-click unsubscribe from a campaign email. Returns the address, for the page.
export async function unsubscribeWithToken(token: string) {
  const contactId = contactFromUnsubscribeToken(token);
  if (!contactId) return null;
  const db = getDb();
  const [contact] = await db.select().from(contacts).where(eq(contacts.id, contactId));
  if (!contact) return null;
  if (!contact.unsubscribedAt) {
    const now = new Date();
    // updatedAt moves on too, so the next sync tells Resend about the opt-out as well.
    await db.update(contacts).set({ unsubscribedAt: now, updatedAt: now }).where(eq(contacts.id, contactId));
  }
  return { email: contact.email };
}

export async function contactForUnsubscribeToken(token: string) {
  const contactId = contactFromUnsubscribeToken(token);
  if (!contactId) return null;
  const [contact] = await getDb()
    .select({ email: contacts.email, unsubscribedAt: contacts.unsubscribedAt })
    .from(contacts)
    .where(eq(contacts.id, contactId));
  return contact ?? null;
}
