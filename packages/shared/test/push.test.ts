import { describe, expect, it } from "vitest";
import { isPushEndpoint, PUSH_LIMITS, pushSubscribeSchema } from "../src/push.ts";

// Which subscriptions the server accepts (step 11b): only https endpoints of
// the push services browsers use, so the server never posts anywhere else.

const KEYS = { p256dh: `B${"A".repeat(86)}`, auth: "A".repeat(22) };

describe("isPushEndpoint", () => {
  it("accepts the push services of Chrome, Firefox, Safari and Edge", () => {
    for (const url of [
      "https://fcm.googleapis.com/fcm/send/abc:def",
      "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
      "https://web.push.apple.com/QGx2",
      "https://api.push.apple.com/3/device/x",
      "https://wns2-bn3p.notify.windows.com/w/?token=BQYAAA",
    ]) {
      expect(isPushEndpoint(url), url).toBe(true);
    }
  });

  it("refuses anything else: other hosts, look-alikes, http, ports, users, fragments and junk", () => {
    for (const url of [
      "https://exemplo.com.br/push",
      "https://fcm.googleapis.com.exemplo.com.br/x",
      "https://evilfcm.googleapis.com/x",
      "https://push.apple.com.exemplo.com.br/x",
      "http://fcm.googleapis.com/fcm/send/x",
      "https://fcm.googleapis.com:443x/x",
      "https://fcm.googleapis.com:8443/x",
      "https://user:pass@fcm.googleapis.com/x",
      "https://fcm.googleapis.com/x#frag",
      "https://127.0.0.1/x",
      "javascript:alert(1)",
      "not a url",
      `https://fcm.googleapis.com/${"x".repeat(PUSH_LIMITS.endpointMax)}`,
    ]) {
      expect(isPushEndpoint(url), url).toBe(false);
    }
  });
});

describe("pushSubscribeSchema", () => {
  it("takes what PushSubscription.toJSON() gives, without extra fields", () => {
    const endpoint = "https://fcm.googleapis.com/fcm/send/abc";
    expect(pushSubscribeSchema.parse({ endpoint, keys: KEYS })).toEqual({ endpoint, keys: KEYS });
    expect(pushSubscribeSchema.safeParse({ endpoint, keys: KEYS, expirationTime: null }).success).toBe(false);
    expect(pushSubscribeSchema.safeParse({ endpoint, keys: { ...KEYS, extra: "x" } }).success).toBe(false);
    expect(pushSubscribeSchema.safeParse({ endpoint, keys: { ...KEYS, p256dh: "A".repeat(86) } }).success).toBe(false);
    expect(pushSubscribeSchema.safeParse({ endpoint, keys: { ...KEYS, auth: "A".repeat(21) } }).success).toBe(false);
    expect(pushSubscribeSchema.safeParse({ endpoint, keys: { ...KEYS, auth: "A".repeat(23) } }).success).toBe(false);
    expect(pushSubscribeSchema.safeParse({ endpoint, keys: { ...KEYS, p256dh: `B${"A".repeat(87)}` } }).success).toBe(false);
    expect(pushSubscribeSchema.safeParse({ endpoint, keys: { ...KEYS, auth: "A+/=".repeat(6) } }).success).toBe(false);
    expect(pushSubscribeSchema.safeParse({ endpoint: "https://exemplo.com.br/x", keys: KEYS }).success).toBe(false);
  });
});
