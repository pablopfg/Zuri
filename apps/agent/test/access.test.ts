import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type AccessConfig, accessConfig, clearAccessKeys, verifyAccessToken } from "../src/gates/access.ts";
import { telegramWebhookSecret } from "../src/gates/telegram.ts";
import { call, errorBody, fakeAssets, ORIGIN, testEnv } from "./helpers.ts";

const TEAM = "equipe.cloudflareaccess.com";
const AUD = "0123456789abcdef".repeat(4);
const CONFIG: AccessConfig = { teamDomain: TEAM, aud: AUD };
const ACCESS_ENV = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };

let keyPair: CryptoKeyPair;
let otherPair: CryptoKeyPair;
let jwks: { keys: JsonWebKey[] };

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const part = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)));

async function sign(payload: Record<string, unknown>, header: Record<string, unknown> = {}, key = keyPair.privateKey) {
  const head = part({ alg: "RS256", kid: "chave-1", typ: "JWT", ...header });
  const body = part(payload);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

const now = () => Math.floor(Date.now() / 1000);
const valid = () => ({ aud: [AUD], iss: `https://${TEAM}`, exp: now() + 300, nbf: now() - 10 });

function fakeCerts() {
  return vi.fn(async (input: RequestInfo | URL) => {
    expect(String(input)).toBe(`https://${TEAM}/cdn-cgi/access/certs`);
    return Response.json(jwks);
  });
}

beforeAll(async () => {
  const params = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
  keyPair = (await crypto.subtle.generateKey(params, true, ["sign", "verify"])) as CryptoKeyPair;
  otherPair = (await crypto.subtle.generateKey(params, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey;
  jwks = { keys: [{ ...jwk, kid: "chave-1" } as JsonWebKey] };
});

afterEach(() => {
  clearAccessKeys();
  vi.restoreAllMocks();
});

describe("accessConfig", () => {
  it("is off when neither setting is present and invalid with only one", () => {
    expect(accessConfig({})).toBeNull();
    expect(accessConfig({ ACCESS_TEAM_DOMAIN: TEAM })).toBe("invalid");
    expect(accessConfig({ ACCESS_AUD: AUD })).toBe("invalid");
    expect(accessConfig({ ACCESS_TEAM_DOMAIN: `https://${TEAM.toUpperCase()}/`, ACCESS_AUD: AUD })).toEqual(CONFIG);
    expect(accessConfig({ ACCESS_TEAM_DOMAIN: "evil.example/.cloudflareaccess.com", ACCESS_AUD: AUD })).toBe("invalid");
  });
});

describe("verifyAccessToken", () => {
  it("accepts a token Access signed for this application", async () => {
    expect(await verifyAccessToken(await sign(valid()), CONFIG, fakeCerts())).toBe(true);
    expect(await verifyAccessToken(await sign({ ...valid(), aud: AUD }), CONFIG, fakeCerts())).toBe(true);
  });

  it("refuses wrong audience, issuer, expiry, not-before, algorithm, key or signature", async () => {
    const cases = [
      await sign({ ...valid(), aud: ["f".repeat(64)] }),
      await sign({ ...valid(), iss: "https://outra.cloudflareaccess.com" }),
      await sign({ ...valid(), exp: now() - 120 }),
      await sign({ ...valid(), exp: undefined }),
      await sign({ ...valid(), exp: "9999999999" }),
      await sign({ ...valid(), nbf: now() + 600 }),
      await sign({ ...valid(), nbf: "0" }),
      await sign(valid(), { alg: "none" }),
      await sign(valid(), { alg: "HS256" }),
      await sign(valid(), { kid: "desconhecida" }),
      await sign(valid(), {}, otherPair.privateKey),
    ];
    for (const [i, token] of cases.entries()) expect(await verifyAccessToken(token, CONFIG, fakeCerts()), `case ${i}`).toBe(false);
  });

  it("refuses malformed tokens without throwing", async () => {
    const good = await sign(valid());
    for (const token of [null, undefined, "", "a.b", "a.b.c.d", "!!!.###.$$$", `${good}x`, "x".repeat(9000), `e30.${part(valid())}.`]) {
      expect(await verifyAccessToken(token, CONFIG, fakeCerts())).toBe(false);
    }
  });

  it("refuses when the key endpoint fails, and caches the keys between calls", async () => {
    const failing = vi.fn(async () => new Response("erro", { status: 500 }));
    expect(await verifyAccessToken(await sign(valid()), CONFIG, failing)).toBe(false);
    const certs = fakeCerts();
    await verifyAccessToken(await sign(valid()), CONFIG, certs);
    await verifyAccessToken(await sign(valid()), CONFIG, certs);
    expect(certs).toHaveBeenCalledTimes(1);
  });
});

describe("gate 3: Cloudflare Access in the Worker", () => {
  it("refuses pages and the API without a valid token, and lets a valid one through", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(fakeCerts());
    const assets = fakeAssets();
    for (const path of ["/", "/api/health"]) {
      const denied = await call(`${ORIGIN}${path}`, {}, { ...ACCESS_ENV, ASSETS: assets.binding });
      expect(denied.status, path).toBe(403);
      expect((await errorBody(denied)).code).toBe("FORBIDDEN");
    }
    expect(assets.fetch).not.toHaveBeenCalled();
    const token = await sign(valid());
    const ok = await call(`${ORIGIN}/api/health`, { headers: { "cf-access-jwt-assertion": token } }, ACCESS_ENV);
    expect(ok.status).toBe(200);
  });

  it("lets only the Telegram webhook through with its secret header and no cookie", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(fakeCerts());
    const secret = await telegramWebhookSecret(testEnv.SESSION_SECRET);
    const env = { ...ACCESS_ENV, TELEGRAM_BOT_TOKEN: "123456:token-de-teste" };
    const webhook = `${ORIGIN}/api/telegram/webhook`;
    const post = (headers: Record<string, string>, overrides: Record<string, string> = env, url = webhook) =>
      call(url, { method: "POST", headers, body: "{}" }, overrides);

    // Past Access: the API answers (401 until the webhook route exists in step 12).
    expect((await post({ "x-telegram-bot-api-secret-token": secret })).status).toBe(401);

    for (const [label, res] of [
      ["no header", await post({})],
      ["wrong secret", await post({ "x-telegram-bot-api-secret-token": `${secret.slice(0, -1)}A` })],
      ["short secret", await post({ "x-telegram-bot-api-secret-token": "abc" })],
      ["with cookie", await post({ "x-telegram-bot-api-secret-token": secret, cookie: "a=b" })],
      ["with authorization", await post({ "x-telegram-bot-api-secret-token": secret, authorization: "Bearer x" })],
      ["other path", await post({ "x-telegram-bot-api-secret-token": secret }, env, `${ORIGIN}/api/health`)],
      ["bot off", await post({ "x-telegram-bot-api-secret-token": secret }, ACCESS_ENV)],
    ] as const) {
      expect(res.status, label).toBe(403);
      expect((await errorBody(res)).code, label).toBe("FORBIDDEN");
    }
    const get = await call(webhook, { headers: { "x-telegram-bot-api-secret-token": secret } }, env);
    expect(get.status).toBe(403);
  });
});
