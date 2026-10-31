import { z } from "zod";
import type { WorkerEnv } from "./env.ts";
import { type AccessConfig, accessConfig } from "./gates/access.ts";

/** What the gates need from the environment, already validated. */
export type Config =
  | {
      usable: true;
      /** The owner's origin; its host is the only one served. */
      publicUrl: URL;
      /** Plain HTTP is accepted only when PUBLIC_URL itself is a loopback http address (local development). */
      allowPlainHttp: boolean;
      access: AccessConfig | null;
      /** All required secrets are present and long enough; without them the API answers NOT_CONFIGURED. */
      secretsReady: boolean;
    }
  | { usable: false };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** Shortest accepted SESSION_SECRET and PASSWORD_PEPPER: 32 characters, as the installer generates 256-bit values. */
export const MIN_SECRET_LENGTH = 32;

const secret = z.string().trim().min(MIN_SECRET_LENGTH);
const requiredSecrets = z.object({
  SESSION_SECRET: secret,
  PASSWORD_PEPPER: secret,
  OWNER_PASSWORD_HASH: z.string().trim().min(1),
  OWNER_EMAIL: z.email(),
});

/**
 * PUBLIC_URL must be a bare origin: https, or http on a loopback host for local
 * development; no path, query, fragment or credentials.
 */
export function parsePublicUrl(value: unknown): { url: URL; allowPlainHttp: boolean } | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
  if (url.protocol === "https:") return { url, allowPlainHttp: false };
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return { url, allowPlainHttp: true };
  return null;
}

/**
 * Reads the configuration on every request (the values are tiny and the isolate
 * may outlive a change of secrets). A bad PUBLIC_URL or half an Access setup makes
 * the whole Worker unusable: it fails closed instead of guessing.
 */
export function readConfig(env: WorkerEnv): Config {
  const parsed = parsePublicUrl(env.PUBLIC_URL);
  if (!parsed) return { usable: false };
  const access = accessConfig(env);
  if (access === "invalid") return { usable: false };
  return {
    usable: true,
    publicUrl: parsed.url,
    allowPlainHttp: parsed.allowPlainHttp,
    access,
    secretsReady: requiredSecrets.safeParse(env).success,
  };
}
