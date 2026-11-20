const KEY = "hellobox.after-sign-in";

// A provider sign-in that stops for a two-factor code lands on the login page, which has no
// other way to know where the person was headed.
export function rememberAfterSignIn(path: string) {
  try {
    sessionStorage.setItem(KEY, path);
  } catch {
    // Without storage they land in the inbox instead.
  }
}

export function takeAfterSignIn(fallback: string) {
  try {
    const path = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    // Only paths on this site, never another origin.
    if (path?.startsWith("/") && !path.startsWith("//")) return path;
  } catch {
    // Falls through to the default.
  }
  return fallback;
}
