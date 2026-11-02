import type { PushSubscribe } from "@zuri/shared";

/**
 * The browser's side of Web Push (step 11b): ask for permission, subscribe
 * with the installation's public key and hand the server what it needs. Loaded
 * only with Settings > Notifications.
 */

export type PushSupport = "supported" | "unsupported" | "denied";

/** Whether this browser can get notifications now. iPhone and iPad need the app on the home screen first. */
export function pushSupport(): PushSupport {
  if (typeof window === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
  return Notification.permission === "denied" ? "denied" : "supported";
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64url.length / 4) * 4, "=");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Thrown when the owner (or the browser) said no to notifications. */
export class PushDenied extends Error {
  override name = "PushDenied";
}

/**
 * Asks for permission and subscribes. A subscription made with another key
 * (the installation's pair changed) is dropped and made again.
 */
export async function subscribe(publicKey: string): Promise<PushSubscribe> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new PushDenied();
  const registration = await navigator.serviceWorker.ready;
  const options = { userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) };
  let subscription: PushSubscription;
  try {
    subscription = await registration.pushManager.subscribe(options);
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== "InvalidStateError") throw error;
    await (await registration.pushManager.getSubscription())?.unsubscribe();
    subscription = await registration.pushManager.subscribe(options);
  }
  const json = subscription.toJSON();
  return { endpoint: json.endpoint ?? subscription.endpoint, keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" } };
}

/** Stops notifications on this browser; the server forgets the device on its own call. */
export async function unsubscribe(): Promise<void> {
  if (pushSupport() === "unsupported") return;
  const registration = await navigator.serviceWorker.ready;
  await (await registration.pushManager.getSubscription())?.unsubscribe();
}
