// Personal mail providers, where one domain is thousands of unrelated people. Blocking one
// is allowed, but settings warns first, since it also blocks everyone you do business with
// who writes from there.
const COMMON_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com",
  "outlook.com", "hotmail.com", "live.com", "msn.com", "outlook.fr", "hotmail.fr", "hotmail.co.uk", "live.fr",
  "yahoo.com", "yahoo.fr", "yahoo.co.uk", "yahoo.co.jp", "ymail.com", "rocketmail.com",
  "icloud.com", "me.com", "mac.com",
  "aol.com",
  "proton.me", "protonmail.com", "pm.me",
  "gmx.com", "gmx.net", "gmx.de", "web.de", "t-online.de",
  "mail.com", "zoho.com", "fastmail.com", "hey.com", "hushmail.com", "duck.com",
  "tutanota.com", "tuta.io", "tutamail.com",
  "yandex.com", "yandex.ru", "mail.ru", "qq.com", "163.com", "126.com", "naver.com",
  "comcast.net", "verizon.net", "att.net", "sbcglobal.net", "btinternet.com",
  "orange.fr", "free.fr", "laposte.net", "libero.it",
]);

export const isCommonMailDomain = (domain: string) => COMMON_MAIL_DOMAINS.has(domain.trim().toLowerCase().replace(/^@/, ""));

// What the sender lists accept: a full address or a bare domain, lowercased.
export function parseBlockTarget(input: string): { value: string; kind: "address" | "domain" } | null {
  const value = input.trim().toLowerCase().replace(/^@/, "");
  if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value) && value.length <= 320) return { value, kind: "address" };
  if (/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(value) && value.length <= 253) return { value, kind: "domain" };
  return null;
}
