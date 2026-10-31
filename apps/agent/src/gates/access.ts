/**
 * Gate 3: Cloudflare Access, when configured (ACCESS_TEAM_DOMAIN and ACCESS_AUD).
 *
 * Access signs every request it lets through with a JWT in the
 * `Cf-Access-Jwt-Assertion` header. Checking it inside the Worker means a host
 * Access does not cover cannot be used to skip it. Adapted from Talorys
 * (apps/agent/src/auth/access.ts, MIT; see NOTICE.md).
 */

export interface AccessConfig {
  /** The Zero Trust team domain, such as `equipe.cloudflareaccess.com`. */
  teamDomain: string;
  /** The Access application's Audience (AUD) tag. */
  aud: string;
}

const TEAM_DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
const AUD = /^[0-9a-f]{64}$/;
/** Clock difference tolerated between Cloudflare's edge and this Worker. */
const LEEWAY_S = 60;
const KEYS_TTL_MS = 10 * 60_000;
/** A token signed with an unknown key refetches the keys at most this often (key rotation). */
const REFETCH_MIN_MS = 60_000;
const MAX_TOKEN_LENGTH = 8192;

/** The Access settings; null when Access is off; "invalid" when only half is set or a value is malformed. */
export function accessConfig(env: { ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string }): AccessConfig | null | "invalid" {
  const teamDomain = (env.ACCESS_TEAM_DOMAIN ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https:\/\//, "")
    .replace(/\/$/, "");
  const aud = (env.ACCESS_AUD ?? "").trim().toLowerCase();
  if (!teamDomain && !aud) return null;
  if (!TEAM_DOMAIN.test(teamDomain) || !AUD.test(aud)) return "invalid";
  return { teamDomain, aud };
}

interface KeyCache {
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
}

// Public signing keys only, per team domain; caching them across requests saves a subrequest.
const caches = new Map<string, KeyCache>();

/** Test hook: forgets the cached signing keys. */
export function clearAccessKeys(): void {
  caches.clear();
}

async function loadKeys(teamDomain: string, fetcher: typeof fetch): Promise<KeyCache> {
  const res = await fetcher(`https://${teamDomain}/cdn-cgi/access/certs`, {
    signal: AbortSignal.timeout(5_000),
    redirect: "error",
  });
  if (!res.ok) throw new Error(`Access keys answered ${res.status}`);
  const body = (await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (!jwk.kid || jwk.kty !== "RSA") continue;
    keys.set(jwk.kid, await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
  }
  const cache = { keys, fetchedAt: Date.now() };
  caches.set(teamDomain, cache);
  return cache;
}

async function signingKey(teamDomain: string, kid: string, fetcher: typeof fetch): Promise<CryptoKey | null> {
  let cache = caches.get(teamDomain);
  if (!cache || Date.now() - cache.fetchedAt > KEYS_TTL_MS) cache = await loadKeys(teamDomain, fetcher);
  const key = cache.keys.get(kid);
  if (key || Date.now() - cache.fetchedAt < REFETCH_MIN_MS) return key ?? null;
  return (await loadKeys(teamDomain, fetcher)).keys.get(kid) ?? null;
}

function base64urlBytes(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("not base64url");
  const b64 = text
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(text.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
}

function decodePart<T>(part: string): T | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(base64urlBytes(part)));
    return typeof value === "object" && value !== null ? (value as T) : null;
  } catch {
    return null;
  }
}

/**
 * True only for a token Access signed for this application that is valid now.
 * Any error (a malformed token, the key endpoint unreachable) is a refusal.
 */
export async function verifyAccessToken(
  token: string | null | undefined,
  config: AccessConfig,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  if (!token || token.length > MAX_TOKEN_LENGTH) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string];
  const header = decodePart<{ alg?: unknown; kid?: unknown }>(rawHeader);
  const payload = decodePart<{ aud?: unknown; iss?: unknown; exp?: unknown; nbf?: unknown }>(rawPayload);
  if (!header || !payload || header.alg !== "RS256" || typeof header.kid !== "string") return false;

  const now = Math.floor(Date.now() / 1000);
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(config.aud)) return false;
  if (payload.iss !== `https://${config.teamDomain}`) return false;
  if (typeof payload.exp !== "number" || payload.exp + LEEWAY_S <= now) return false;
  if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || payload.nbf - LEEWAY_S > now)) return false;

  try {
    const key = await signingKey(config.teamDomain, header.kid, fetcher);
    if (!key) return false;
    const data = new TextEncoder().encode(`${rawHeader}.${rawPayload}`);
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64urlBytes(rawSignature), data);
  } catch {
    return false;
  }
}
