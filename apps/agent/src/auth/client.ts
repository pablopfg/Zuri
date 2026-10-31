import { AppError } from "../http/errors.ts";

/**
 * Where the Worker puts the visitor's location, taken from request.cf at the
 * edge. Any copy sent by the client is removed first (index.ts), so the API
 * never trusts a location that came from the browser.
 */
export const CLIENT_GEO_HEADER = "x-zuri-client-geo";

export interface ClientGeo {
  country: string;
  region: string;
  city: string;
  asn: number | null;
  colo: string;
}

/** Who is knocking: the network for the rate limit and what the access activity records. */
export interface ClientInfo {
  /** IPv4 address, or the IPv6 /64: the rate limit's unit. */
  network: string;
  ip: string;
  userAgent: string;
  geo: ClientGeo;
}

const text = (value: unknown, max: number) => (typeof value === "string" ? stripControl(value).slice(0, max) : "");

/** Control characters out, so a crafted user agent can't break a log line or a CSV. */
export function stripControl(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point.
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "");
}

/** The edge's view of the request, as the Worker forwards it. Bad or missing JSON reads as unknown. */
export function geoFromCf(cf: IncomingRequestCfProperties | undefined): ClientGeo {
  return {
    country: text(cf?.country, 2),
    region: text(cf?.region, 64),
    city: text(cf?.city, 64),
    asn: typeof cf?.asn === "number" && Number.isInteger(cf.asn) && cf.asn >= 0 ? cf.asn : null,
    colo: text(cf?.colo, 8),
  };
}

function parseGeo(header: string | null): ClientGeo {
  if (!header || header.length > 1024) return geoFromCf(undefined);
  try {
    return geoFromCf(JSON.parse(header) as IncomingRequestCfProperties);
  } catch {
    return geoFromCf(undefined);
  }
}

/**
 * The visitor, from the headers Cloudflare sets. CF-Connecting-IP comes from
 * the edge and the client cannot set it. Without it (only off Cloudflare) every
 * request would share one rate-limit bucket, so it is refused, except in local
 * development over loopback http.
 */
export function clientInfo(request: Request, development: boolean): ClientInfo {
  const ip = text(request.headers.get("cf-connecting-ip"), 64).trim();
  const network = ip ? networkKey(ip) : development ? "local" : null;
  if (network === null) throw new AppError("NOT_CONFIGURED", "error.clientAddressMissing");
  return {
    network,
    ip,
    userAgent: text(request.headers.get("user-agent"), 300),
    geo: parseGeo(request.headers.get(CLIENT_GEO_HEADER)),
  };
}

function ipv4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  return octets.every((n) => n >= 0 && n <= 255) ? octets : null;
}

/** Eight hextets, or null when `address` is not an IPv6 address. A trailing dotted quad is two hextets. */
export function expandIpv6(address: string): number[] | null {
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const pieces = (half: string): number[] | null => {
    if (!half) return [];
    const out: number[] = [];
    for (const part of half.split(":")) {
      if (part.includes(".")) {
        const octets = ipv4(part);
        if (!octets) return null;
        const [a = 0, b = 0, c = 0, d = 0] = octets;
        out.push((a << 8) | b, (c << 8) | d);
      } else if (/^[0-9a-f]{1,4}$/.test(part)) {
        out.push(Number.parseInt(part, 16));
      } else {
        return null;
      }
    }
    return out;
  };
  const left = pieces(halves[0] ?? "");
  const right = halves.length === 2 ? pieces(halves[1] ?? "") : [];
  if (!left || !right) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...Array<number>(missing).fill(0), ...right];
}

/**
 * The rate limit's unit for an address. IPv6 goes by /64: one subscriber
 * usually holds a whole /64 and could otherwise rotate addresses for a fresh
 * allowance on every guess. IPv4-mapped IPv6 counts as its IPv4 address.
 * Anything unparseable is its own bucket, never a shared one.
 */
export function networkKey(ip: string): string {
  const v4 = ipv4(ip);
  if (v4) return v4.join(".");
  const groups = expandIpv6(ip.toLowerCase().split("%")[0] ?? "");
  if (!groups) return `?${ip.slice(0, 64)}`;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const [hi = 0, lo = 0] = groups.slice(6);
    return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
  }
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(":")}::/64`;
}
