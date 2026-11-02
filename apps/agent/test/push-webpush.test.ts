import { fromBase64Url, toBase64Url } from "@zuri/shared";
import { describe, expect, it } from "vitest";
import { encryptPush, validVapidKeys, vapidAuthorization } from "../src/push/webpush.ts";
import { testEnv } from "./helpers.ts";

// Web Push by hand (step 11b): the message encryption checked against the
// RFC 8291 test vector and against a receiver written here from the RFC, and
// the VAPID signature checked with the public key, as a push service does.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** RFC 8291, Appendix A. */
const VECTOR = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  result:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

function jwk(publicKey: string, privateKey?: string): JsonWebKey {
  const pub = fromBase64Url(publicKey);
  return { kty: "EC", crv: "P-256", x: toBase64Url(pub.slice(1, 33)), y: toBase64Url(pub.slice(33)), ...(privateKey ? { d: privateKey } : {}) };
}

async function ecdhPair(publicKey: string, privateKey: string): Promise<CryptoKeyPair> {
  return {
    publicKey: await crypto.subtle.importKey("jwk", jwk(publicKey), { name: "ECDH", namedCurve: "P-256" }, true, []),
    privateKey: await crypto.subtle.importKey("jwk", jwk(publicKey, privateKey), { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]),
  };
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

/** The browser's side, from RFC 8291 section 3.4 and RFC 8188 section 2, written apart from the code under test. */
async function decrypt(body: Uint8Array, ua: CryptoKeyPair, authSecret: Uint8Array): Promise<string> {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16);
  const idlen = body[20] ?? 0;
  const asPublic = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);
  expect(rs).toBe(4096);
  expect(idlen).toBe(65);
  const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const derive = { name: "ECDH", public: asKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const shared = new Uint8Array(await crypto.subtle.deriveBits(derive, ua.privateKey, 256));
  const uaPublic = new Uint8Array((await crypto.subtle.exportKey("raw", ua.publicKey)) as ArrayBuffer);
  const info = new Uint8Array([...encoder.encode("WebPush: info\0"), ...uaPublic, ...asPublic, 1]);
  const ikm = await hmac(await hmac(authSecret, shared), info);
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, new Uint8Array([...encoder.encode("Content-Encoding: aes128gcm\0"), 1]))).slice(0, 16);
  const nonce = (await hmac(prk, new Uint8Array([...encoder.encode("Content-Encoding: nonce\0"), 1]))).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext));
  // The last record ends with 0x02 and optional zeros.
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  expect(padded[end]).toBe(2);
  return decoder.decode(padded.slice(0, end));
}

describe("encryptPush", () => {
  it("matches the RFC 8291 test vector byte for byte", async () => {
    const body = await encryptPush({ p256dh: VECTOR.uaPublic, auth: VECTOR.authSecret }, encoder.encode(VECTOR.plaintext), {
      salt: fromBase64Url(VECTOR.salt),
      serverKeys: await ecdhPair(VECTOR.asPublic, VECTOR.asPrivate),
    });
    expect(toBase64Url(body)).toBe(VECTOR.result);
  });

  it("the browser's side opens the vector's message", async () => {
    const text = await decrypt(fromBase64Url(VECTOR.result), await ecdhPair(VECTOR.uaPublic, VECTOR.uaPrivate), fromBase64Url(VECTOR.authSecret));
    expect(text).toBe(VECTOR.plaintext);
  });

  it("each message gets a fresh key and salt, and only the subscriber can open it", async () => {
    const ua = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const subscription = { p256dh: toBase64Url(new Uint8Array((await crypto.subtle.exportKey("raw", ua.publicKey)) as ArrayBuffer)), auth: toBase64Url(auth) };
    const message = JSON.stringify({ title: "Água 💧", body: "Beber um copo de água" });
    const a = await encryptPush(subscription, encoder.encode(message));
    const b = await encryptPush(subscription, encoder.encode(message));
    expect(toBase64Url(a.slice(0, 16))).not.toBe(toBase64Url(b.slice(0, 16)));
    expect(toBase64Url(a.slice(21, 86))).not.toBe(toBase64Url(b.slice(21, 86)));
    expect(await decrypt(a, ua, auth)).toBe(message);
    // Another secret: the tag doesn't match, nothing opens.
    await expect(decrypt(a, ua, crypto.getRandomValues(new Uint8Array(16)))).rejects.toThrow();
  });

  it("refuses broken keys and a message too long for one record", async () => {
    const auth = VECTOR.authSecret;
    await expect(encryptPush({ p256dh: VECTOR.uaPublic.slice(0, 40), auth }, encoder.encode("x"))).rejects.toThrow(TypeError);
    await expect(encryptPush({ p256dh: VECTOR.uaPublic, auth: "AAAA" }, encoder.encode("x"))).rejects.toThrow(TypeError);
    // 4096 - 86 (header) - 16 (tag) - 1 (delimiter) = 3993 bytes fit; one more doesn't.
    const sub = { p256dh: VECTOR.uaPublic, auth };
    await expect(encryptPush(sub, new Uint8Array(3993))).resolves.toHaveLength(4096);
    await expect(encryptPush(sub, new Uint8Array(3994))).rejects.toThrow(RangeError);
  });
});

describe("VAPID", () => {
  const keys = { publicKey: testEnv.VAPID_PUBLIC_KEY ?? "", privateKey: testEnv.VAPID_PRIVATE_KEY ?? "" };

  it("tells a usable pair from anything else", () => {
    expect(validVapidKeys(keys)).toBe(true);
    expect(validVapidKeys({ publicKey: keys.publicKey })).toBe(false);
    expect(validVapidKeys({ publicKey: keys.publicKey.slice(1), privateKey: keys.privateKey })).toBe(false);
    expect(validVapidKeys({ publicKey: keys.publicKey, privateKey: `${keys.privateKey}AA` })).toBe(false);
    expect(validVapidKeys({ publicKey: "não é base64", privateKey: keys.privateKey })).toBe(false);
  });

  it("signs a JWT for the push service's origin, valid for 12 hours, that the public key verifies", async () => {
    const now = Date.UTC(2026, 10, 2, 12);
    const header = await vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc:def", keys, "https://zuri.exemplo.com.br", now);
    const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, head, claims, signature, k] = match as unknown as [string, string, string, string, string];
    expect(k).toBe(keys.publicKey);
    expect(JSON.parse(decoder.decode(fromBase64Url(head)))).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(decoder.decode(fromBase64Url(claims)))).toEqual({ aud: "https://fcm.googleapis.com", exp: now / 1000 + 12 * 3600, sub: "https://zuri.exemplo.com.br" });
    const verifier = await crypto.subtle.importKey("jwk", jwk(keys.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const sig = fromBase64Url(signature);
    expect(sig).toHaveLength(64);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifier, sig, encoder.encode(`${head}.${claims}`))).toBe(true);
  });
});
