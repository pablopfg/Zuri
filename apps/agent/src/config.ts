import { isPasswordHash, isUsableSetupCode } from "@zuri/shared";
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
/** Shortest accepted SESSION_SECRET and PASSWORD_PEPPER (48+ random characters, step 3 of the specification). */
export const MIN_SECRET_LENGTH = 48;
/** Shortest OWNER_PASSWORD accepted in place of OWNER_PASSWORD_HASH (installation without the installer). */
export const MIN_OWNER_PASSWORD_LENGTH = 20;

const secret = z.string().trim().min(MIN_SECRET_LENGTH);
/**
 * The password itself is checked inside the Durable Object: after the first
 * change it lives in the database, and the owner deletes OWNER_PASSWORD. Here a
 * password secret that is set must at least be well formed: a typo fails closed.
 */
const requiredSecrets = z.object({
  SESSION_SECRET: secret,
  PASSWORD_PEPPER: secret,
  // The first access stores the e-mail in the database; the secret is for older installations.
  OWNER_EMAIL: z.email().optional(),
  OWNER_PASSWORD_HASH: z.string().refine(isPasswordHash).optional(),
  // Without the hash, the plain password is accepted until the first sign-in replaces it.
  OWNER_PASSWORD: z.string().min(MIN_OWNER_PASSWORD_LENGTH).optional(),
  // A code that is set must be usable: a short or repetitive one fails closed, it is never ignored.
  SETUP_CODE: z.string().refine(isUsableSetupCode).optional(),
}).refine(
  // A password secret signs in only together with the e-mail it belongs to.
  (env) => (env.OWNER_PASSWORD === undefined && env.OWNER_PASSWORD_HASH === undefined) || env.OWNER_EMAIL !== undefined,
  { path: ["OWNER_EMAIL"] },
);

/** Names (never values) of the secrets that are missing or malformed, for the log of the health check. */
export function secretProblems(env: WorkerEnv): string[] {
  const result = requiredSecrets.safeParse(env);
  return result.success ? [] : [...new Set(result.error.issues.map((issue) => String(issue.path[0])))];
}

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
