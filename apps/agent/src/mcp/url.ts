import type { McpServerProblem } from "@zuri/shared";
import { expandIpv6, ipv4 } from "../auth/client.ts";

/**
 * Where an MCP server may be (step 18, "fetch protegido"): only https on a
 * public host. The same checks guard the site monitor of step 22.
 */

/** Names that only mean something inside a private network. */
const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home", ".home.arpa", ".corp", ".private", ".test", ".invalid"];
/** Local development only (loopback http PUBLIC_URL): a test server on this machine. */
const LOCAL_DEV_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** IPv4 addresses that are not ordinary public unicast: private, loopback, link-local (and metadata), CGNAT, documentation, benchmark, multicast, reserved. */
function privateIpv4([a = 0, b = 0, c = 0]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function privateIpv6(groups: number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, , , g5 = 0, g6 = 0, g7 = 0] = groups;
  const embedded = () => [(g6 >> 8) & 255, g6 & 255, (g7 >> 8) & 255, g7 & 255];
  if (groups.slice(0, 7).every((g) => g === 0)) return true; // :: and ::1
  if (groups.slice(0, 5).every((g) => g === 0) && g5 === 0xffff) return privateIpv4(embedded()); // IPv4-mapped
  if (g0 === 0x64 && g1 === 0xff9b) return privateIpv4(embedded()); // NAT64
  if ((g0 & 0xfe00) === 0xfc00) return true; // unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation
  if (g0 === 0x2002) return privateIpv4([g1 >> 8, g1 & 255, g2 >> 8]); // 6to4 wraps an IPv4 address
  if (g0 === 0x2001 && g1 === 0) return true; // Teredo
  // Anything outside global unicast (2000::/3) is reserved.
  return (g0 & 0xe000) !== 0x2000;
}

/** True when `address` (an IP literal, IPv6 with or without brackets) is not a public unicast address. */
export function isPrivateAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "").toLowerCase();
  const v4 = ipv4(bare);
  if (v4) return privateIpv4(v4);
  const v6 = expandIpv6(bare.split("%")[0] ?? "");
  // Not an address at all: refused, never assumed public.
  return v6 ? privateIpv6(v6) : true;
}

const isIpLiteral = (host: string) => ipv4(host) !== null || host.startsWith("[");

/** The host as the checks read it: lower case, without the final dots ("localhost." is "localhost"). */
export const bareHost = (url: URL) => url.hostname.toLowerCase().replace(/\.+$/, "");

/** True for a private address, or a name that only means something on a private network (or has no dot). */
export function isPrivateHost(host: string): boolean {
  if (isIpLiteral(host)) return isPrivateAddress(host);
  return !host.includes(".") || PRIVATE_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix));
}

/** A refusal of where a server is. Its code becomes the server's problem, worded by the interface. */
export class McpEndpointError extends Error {
  constructor(readonly problem: McpServerProblem) {
    super(problem);
    this.name = "McpEndpointError";
  }
}

/**
 * An endpoint the owner typed, normalized; null when it can't be used: not
 * https (development also takes http on this machine), credentials or a
 * fragment in it, a port other than 443, or a private host.
 */
export function endpointUrl(raw: string, opts: { development: boolean }): URL | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const host = bareHost(url);
  const localDev = opts.development && LOCAL_DEV_HOSTS.has(host);
  if (url.protocol !== "https:" && !(localDev && url.protocol === "http:")) return null;
  if (url.username || url.password || url.hash) return null;
  if (localDev) return url;
  if (url.port !== "" || isPrivateHost(host)) return null;
  return url;
}

/** Looks up a host's addresses. Injected, so the tests need no public DNS. */
export type Resolver = (host: string, signal?: AbortSignal) => Promise<string[]>;

/** How long one DNS lookup may take. */
export const DNS_TIMEOUT_MS = 5_000;

/**
 * A and AAAA over DNS-over-HTTPS: the Workers runtime has no DNS API. Two
 * subrequests per new connection (rule P9 counts them).
 */
export function dohResolver(fetcher: typeof fetch): Resolver {
  return async (host, signal) => {
    const lookup = async (type: "A" | "AAAA") => {
      const res = await fetcher(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, {
        headers: { accept: "application/dns-json" },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(DNS_TIMEOUT_MS)]) : AbortSignal.timeout(DNS_TIMEOUT_MS),
        redirect: "manual",
      });
      if (!res.ok) throw new Error("dns");
      const body = (await res.json()) as { Answer?: { type?: unknown; data?: unknown }[] };
      const wanted = type === "A" ? 1 : 28;
      return (body.Answer ?? []).filter((a) => a.type === wanted && typeof a.data === "string").map((a) => a.data as string);
    };
    const [a, aaaa] = await Promise.all([lookup("A"), lookup("AAAA")]);
    return [...a, ...aaaa];
  };
}

/**
 * Refuses a host whose DNS answers include a private address, so a public
 * name can't point Zuri inside a network. Runs before every new connection;
 * after it, requests go only to that origin and never follow a redirect.
 */
export async function assertPublicHost(url: URL, resolve: Resolver, opts: { development: boolean; signal?: AbortSignal }): Promise<void> {
  const host = bareHost(url);
  if (isIpLiteral(host)) {
    if (!(opts.development && LOCAL_DEV_HOSTS.has(host)) && isPrivateAddress(host)) throw new McpEndpointError("private_address");
    return;
  }
  if (opts.development && LOCAL_DEV_HOSTS.has(host)) return;
  let addresses: string[];
  try {
    addresses = await resolve(host, opts.signal);
  } catch {
    throw new McpEndpointError("dns");
  }
  if (addresses.length === 0) throw new McpEndpointError("dns");
  if (addresses.some(isPrivateAddress)) throw new McpEndpointError("private_address");
}
