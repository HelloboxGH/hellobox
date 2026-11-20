// Only paths on this site, so a link can't send someone elsewhere after signing in.
export const safeNext = (value: string | null | undefined) =>
  value && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\") ? value : "/inbox";
