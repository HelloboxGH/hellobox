import { parseAdminEmails, setting } from "@hellobox/config";

// ALLOW_SIGNUPS=false closes registration. A new account is then only made for an instance
// admin (an address in ADMIN_EMAILS) or for someone with an open workspace invitation.
// Anyone who already has an account signs in as usual.
export const signupsClosed = (value = setting("ALLOW_SIGNUPS")) => value?.trim().toLowerCase() === "false";

export async function mayCreateAccount(
  email: string,
  hasOpenInvitation: (address: string) => Promise<boolean>,
  options: { closed?: boolean; admins?: string[] } = {},
) {
  if (!(options.closed ?? signupsClosed())) return true;
  const address = email.trim().toLowerCase();
  if ((options.admins ?? parseAdminEmails()).includes(address)) return true;
  return hasOpenInvitation(address);
}

export const SIGNUPS_CLOSED_MESSAGE = "Sign-ups are closed on this server. Ask an admin to invite you.";
