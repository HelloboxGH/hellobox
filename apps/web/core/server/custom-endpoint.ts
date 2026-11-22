import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { isProduction } from "@hellobox/config";
import { guardedLookup, isBlockedAddress } from "@hellobox/mail";
import { badRequest } from "nezt";

export { guardedLookup, isBlockedAddress };

// Custom AI endpoints are URLs chosen by users, and our server is what calls them.
// These checks keep those calls away from anything on our own network.

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

const allowsLocal = () => !isProduction();

const unreachable = () =>
  badRequest("That address can't be used. Enter a public HTTPS address for your AI provider");

function assertSafeUrl(url: URL) {
  if (url.protocol !== "https:" && !(allowsLocal() && url.protocol === "http:")) throw unreachable();
  if (url.username || url.password) throw unreachable();
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && isBlockedAddress(host) && !allowsLocal()) throw unreachable();
}

// Accepts the base URL or the full endpoint, since providers document either one.
export function normalizeBaseUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw unreachable();
  }
  assertSafeUrl(url);
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
  return url.toString().replace(/\/+$/, "");
}

export function postToCustomEndpoint(
  baseUrl: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ ok: boolean; body: unknown }> {
  const url = new URL(`${baseUrl}/chat/completions`);
  assertSafeUrl(url);
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    // Node's request doesn't follow redirects, so a redirect can't lead anywhere internal.
    const req = request(
      url,
      { method: "POST", headers, lookup: guardedLookup, signal: AbortSignal.timeout(60_000) },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy();
            reject(badRequest("Your AI provider sent back too much data"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            // Handled by the caller, as a reply with nothing in it.
          }
          const status = res.statusCode ?? 500;
          resolve({ ok: status >= 200 && status < 300, body: parsed });
        });
        res.on("error", () => reject(badRequest("Couldn't reach your AI provider")));
      },
    );
    req.on("error", () => reject(badRequest("Couldn't reach your AI provider")));
    req.end(body);
  });
}
