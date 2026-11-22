import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { isProduction } from "@hellobox/config";

// URLs people give us (AI endpoints, webhooks, ntfy servers) are called by our servers.
// These checks keep those calls away from anything on our own network.

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(network, prefix, "ipv6");
}

// An IPv4 address written as IPv6 reaches the same host, so it gets the IPv4 rules.
export function isBlockedAddress(address: string) {
  const mapped = address.toLowerCase().match(/^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);
  if (mapped) {
    const ipv4 =
      mapped[1] ??
      [mapped[2], mapped[3]]
        .map((part) => Number.parseInt(part ?? "0", 16))
        .flatMap((value) => [value >> 8, value & 255])
        .join(".");
    return blocked.check(ipv4, "ipv4");
  }
  const family = isIP(address);
  if (!family) return true;
  return blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

const allowsLocal = () => !isProduction();

// Checked as the connection opens, so a host can't pass a check and then change its DNS.
export const guardedLookup = ((hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
    if (error) return callback(error, "", 0);
    if (!allowsLocal() && addresses.some((item) => isBlockedAddress(item.address))) {
      return callback(new Error("Blocked address"), "", 0);
    }
    if (options.all) return callback(null, addresses as never);
    const [first] = addresses;
    return callback(null, first?.address ?? "", first?.family ?? 0);
  });
}) as LookupFunction;

export class UnsafeUrlError extends Error {}

// Public HTTPS only (plain HTTP and local addresses are fine outside production), with no
// credentials in the URL and no literal private address.
export function assertPublicUrl(raw: string | URL) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("That isn't a valid address");
  }
  if (url.protocol !== "https:" && !(allowsLocal() && url.protocol === "http:")) {
    throw new UnsafeUrlError("Use an https:// address");
  }
  if (url.username || url.password) throw new UnsafeUrlError("Leave the username and password out of the address");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && isBlockedAddress(host) && !allowsLocal()) throw new UnsafeUrlError("That address can't be used");
  return url;
}

/**
 * POSTs to a URL someone gave us. DNS is checked as the connection opens, redirects are
 * not followed, and the reply is capped, so the address can't lead anywhere internal.
 */
export function postToPublicUrl(
  raw: string,
  body: string,
  headers: Record<string, string>,
  { timeoutMs = 10_000, maxBytes = 64 * 1024 } = {},
): Promise<{ status: number; body: string }> {
  const url = assertPublicUrl(raw);
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "POST",
        headers: { "Content-Length": Buffer.byteLength(body).toString(), ...headers },
        lookup: guardedLookup,
        signal: AbortSignal.timeout(timeoutMs),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size <= maxBytes) chunks.push(chunk);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
