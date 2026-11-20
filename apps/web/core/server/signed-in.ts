import { getSessionCookie } from "better-auth/cookies";
import { getAuth } from "@/core/auth";
import { safeNext } from "@/core/safe-next";

// Pages a signed-in person has no use for. Reset password isn't here: its emailed link
// must work even while signed in.
const AUTH_PAGES = new Set(["/login", "/signup", "/forgot-password"]);

/**
 * Whether the request carries a session that really checks out. A leftover cookie for an
 * expired session is no session, which keeps /login from sending someone to an inbox that
 * would send them straight back. Demo (anonymous) visitors don't count, so they can sign up.
 */
export async function hasLiveSession(request: Request): Promise<boolean> {
  // Most visitors have no session cookie: skip the database for them.
  if (!getSessionCookie(request)) return false;
  try {
    const session = await getAuth().api.getSession({ headers: request.headers });
    return !!session && !(session.user as { isAnonymous?: boolean | null }).isAnonymous;
  } catch (error) {
    // The page must still load if the session can't be read.
    console.error("[auth] Couldn't read the session:", error);
    return false;
  }
}

/**
 * Where to send a signed-in visitor of the sign-in pages, or null to let the page render.
 * Run from the proxy, so the pages stay static and nobody signed in sees them first.
 */
export async function signedInRedirect(request: Request, url: URL): Promise<string | null> {
  if (!AUTH_PAGES.has(url.pathname)) return null;
  if (!(await hasLiveSession(request))) return null;
  return safeNext(url.searchParams.get("next"));
}
