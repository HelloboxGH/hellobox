import type { Entitlements } from "@hellobox/extensions";
import { roomError } from "./entitlements";

const format = (value: number) => value.toLocaleString("en-US");

// The typed error opens the upgrade dialog for admins and tells members who to ask.
// Null when `adding` more contacts fit, which is always the case with no billing.
export function contactLimitError(
  ctx: { role: string; entitlements: Entitlements },
  current: number,
  adding: number,
) {
  const limit = ctx.entitlements.limits.contacts;
  if (!Number.isFinite(limit)) return null;
  const room = Math.max(limit - current, 0);
  if (adding <= room) return null;
  return roomError(
    ctx,
    "contacts",
    current,
    room
      ? `Your plan stores up to ${format(limit)} contacts, so only ${format(room)} more fit`
      : `Your plan stores up to ${format(limit)} contacts`,
    current + adding,
  );
}
