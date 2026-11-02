// Before any schema here: the package is marked side-effect free, so index.ts alone can't order it.
import "./zod-config.ts";

import { z } from "zod";

/**
 * Web Push (step 11b): notices reach the owner's devices through the browser's
 * push service, encrypted end to end (RFC 8291) and signed with the
 * installation's VAPID key (RFC 8292). The push service only sees ciphertext.
 */

const DAY = 24 * 3_600_000;

export const PUSH_LIMITS = {
  /** Devices that receive notices at once (spec, step 11). */
  maxDevices: 3,
  /** A device that hasn't opened the app for this long stops receiving and is removed. */
  staleMs: 7 * DAY,
  /** How often a device tells the server it is still in use (one write a day, at most). */
  seenEveryMs: DAY,
  /** Test notices per hour, from Settings > Notices. */
  testsPerHour: 3,
  /** How long a push service keeps an undelivered notice, in seconds (a day). */
  ttlSeconds: 86_400,
  /** Longest title and body sent: the payload must fit a push message (4 KB). */
  titleMax: 120,
  bodyMax: 600,
  endpointMax: 1_024,
} as const;

/**
 * The push services browsers use today. A subscription pointing anywhere else
 * is refused: the server only ever posts to these hosts, so a crafted
 * subscription can't make it call an address someone chose.
 */
const PUSH_HOSTS: readonly RegExp[] = [
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^(?:[a-z0-9-]+\.)*push\.apple\.com$/,
  /^(?:[a-z0-9-]+\.)*notify\.windows\.com$/,
];

/** Whether an endpoint is https, on a known push service, with no port, user or fragment. */
export function isPushEndpoint(value: string): boolean {
  if (value.length > PUSH_LIMITS.endpointMax) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "" || url.hash !== "") return false;
  return PUSH_HOSTS.some((host) => host.test(url.hostname));
}

const base64Url = (min: number, max: number) => z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${min},${max}}$`));

/**
 * What the browser's PushSubscription.toJSON() gives, trimmed to the fields
 * used. Built inside a pure function: the bundler keeps the arguments of a pure
 * call, which would leave Zod in the interface (armadilhas.md).
 */
export const pushSubscribeSchema = /* @__PURE__ */ (() =>
  z.object({
    endpoint: z.string().refine(isPushEndpoint),
    keys: z
      .object({
        // A P-256 public key, uncompressed (65 bytes = 87 characters), and a 16-byte secret (22 characters).
        p256dh: base64Url(87, 88),
        auth: base64Url(22, 24),
      })
      .strict(),
  })
  .strict())();
export type PushSubscribe = z.infer<typeof pushSubscribeSchema>;

/** A device saying it still opens the app, or forgetting itself; only the endpoint identifies it. */
export const pushEndpointSchema = /* @__PURE__ */ (() => z.object({ endpoint: z.string().max(PUSH_LIMITS.endpointMax) }).strict())();

export interface PushDevice {
  id: string;
  /** The browser's user agent when it signed up; the interface turns it into "Chrome on Android". */
  userAgent: string;
  createdAt: string;
  lastSeenAt: string;
  /** The last time a notice reached its push service, or null. */
  lastSentAt: string | null;
}

export interface PushStatus {
  /** The installation's public VAPID key, or null when push isn't set up. Public by design. */
  publicKey: string | null;
  devices: PushDevice[];
  max: number;
}

/** What the service worker gets: plain text and an internal page, nothing else. */
export interface PushPayload {
  id: string;
  title: string;
  body: string;
  link: string | null;
  /** High and critical notices stay on screen until the owner acts. */
  sticky: boolean;
}
