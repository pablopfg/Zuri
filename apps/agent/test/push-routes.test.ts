import { AGENT_INSTANCE_NAME, apiErrorSchema, type NoticePage, type PushDevice, type PushStatus, toBase64Url } from "@zuri/shared";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import { call, CSRF, HUMAN_TOKEN, ORIGIN, TEST_EMAIL, TEST_PASSWORD, testEnv } from "./helpers.ts";

// Settings > Notices, push part, through the Worker as the interface calls it (step 11b).

const IP = "192.0.2.172";
let cookie = "";
/** The session and the browser's device cookie, as a browser sends both. */
let withDevice = "";
const owner = () => testEnv.AGENT.get(testEnv.AGENT.idFromName(AGENT_INSTANCE_NAME));
const inOwner = <T>(fn: (agent: ZuriAgent) => T | Promise<T>) => runInDurableObject(owner(), (agent: ZuriAgent) => fn(agent));

const headers = (withCookie = true) => ({
  ...CSRF,
  "content-type": "application/json",
  "cf-connecting-ip": IP,
  "user-agent": "Mozilla/5.0 (Linux; Android 15) Chrome/140.0 Mobile Safari/537.36",
  ...(withCookie ? { cookie } : {}),
});

function api(method: string, path: string, body?: unknown, asBrowser = false) {
  return call(`${ORIGIN}/api${path}`, {
    method,
    headers: { ...headers(), ...(asBrowser ? { cookie: withDevice } : {}) },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

async function json<T>(res: Response, status: number): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await res.json()) as T;
}

const refusal = async (res: Response, status: number) => apiErrorSchema.parse(await json(res, status));

async function subscription(host = "fcm.googleapis.com") {
  const keys = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  return {
    endpoint: `https://${host}/fcm/send/${crypto.randomUUID()}`,
    keys: {
      p256dh: toBase64Url(new Uint8Array((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer)),
      auth: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    },
  };
}

const confirmedLongAgo = () => inOwner((agent) => agent.store.db.run(`UPDATE zur_sessions SET confirmed_at = ?`, Date.now() - 15 * 60_000));
const confirmNow = async () => expect((await api("POST", "/auth/confirm", { password: TEST_PASSWORD })).status).toBe(204);

beforeAll(async () => {
  const res = await call(`${ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: headers(false),
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD, turnstileToken: HUMAN_TOKEN }),
  });
  expect(res.status).toBe(200);
  const set = res.headers.getSetCookie();
  cookie = set.find((c) => c.startsWith("__Host-zuri_session="))?.split(";")[0] ?? "";
  const device = set.find((c) => c.startsWith("__Host-zuri_device="))?.split(";")[0] ?? "";
  expect(device).not.toBe("");
  withDevice = `${cookie}; ${device}`;
});

// Adding a device raises a security alert, which goes out by push at once: the push
// services answer here, never on the network (an unknown answer would drop the device).
const pushed: string[] = [];
beforeEach(() => {
  pushed.length = 0;
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!/^https:\/\/(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[\w-]+\.notify\.windows\.com)\//.test(url)) return real(input, init);
    pushed.push(url);
    return new Response(null, { status: 201 });
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await inOwner((agent) => agent.store.db.run(`DELETE FROM zur_push_devices`));
});

const MISSING = "0b8f8a52-5b2c-4c55-9a4c-2f1f3e1f4a10";

describe("the push routes", () => {
  const routes = [
    ["GET", "/push"],
    ["POST", "/push/devices"],
    ["DELETE", `/push/devices/${MISSING}`],
    ["POST", "/push/test"],
  ] as const;

  it("need a session and the CSRF header", async () => {
    for (const [method, path] of routes) {
      const anonymous = await call(`${ORIGIN}/api${path}`, { method, headers: headers(false), body: method === "GET" ? null : "{}" });
      expect(anonymous.status, `${method} ${path}`).toBe(401);
      const noCsrf = await call(`${ORIGIN}/api${path}`, { method, headers: { cookie, "content-type": "application/json" }, body: method === "GET" ? null : "{}" });
      expect(noCsrf.status, `${method} ${path}`).toBe(403);
    }
  });

  it("answer the public key and the devices", async () => {
    expect(await json<PushStatus>(await api("GET", "/push"), 200)).toEqual({ publicKey: testEnv.VAPID_PUBLIC_KEY, devices: [], max: 3 });
  });

  it("add a device only with the password typed recently, and tell the owner", async () => {
    await confirmedLongAgo();
    const sub = await subscription();
    expect((await refusal(await api("POST", "/push/devices", sub), 403)).code).toBe("RECENT_AUTH_REQUIRED");
    await confirmNow();
    const { device } = await json<{ device: PushDevice }>(await api("POST", "/push/devices", sub), 201);
    expect(device.userAgent).toContain("Android");
    const status = await json<PushStatus>(await api("GET", "/push"), 200);
    expect(status.devices.map((d) => d.id)).toEqual([device.id]);
    // The access event became a security alert by the end of the request.
    const page = await json<NoticePage>(await api("GET", "/notices"), 200);
    expect(page.notices.some((n) => n.kind === "security" && n.title === "Aparelho novo recebendo avisos")).toBe(true);
  });

  it("refuse a subscription outside the known push services, or malformed", async () => {
    await confirmNow();
    const sub = await subscription();
    for (const endpoint of ["https://exemplo.com.br/push", "http://fcm.googleapis.com/fcm/send/x", "https://fcm.googleapis.com:8443/x", "https://user@fcm.googleapis.com/x", "https://fcm.googleapis.com.exemplo.com.br/x"]) {
      expect((await refusal(await api("POST", "/push/devices", { ...sub, endpoint }), 400)).details, endpoint).toEqual({ fields: ["endpoint"] });
    }
    expect((await refusal(await api("POST", "/push/devices", { ...sub, keys: { ...sub.keys, p256dh: "curta" } }), 400)).code).toBe("VALIDATION_FAILED");
    expect((await refusal(await api("POST", "/push/devices", { ...sub, expirationTime: null }), 400)).code).toBe("VALIDATION_FAILED");
    expect((await refusal(await api("POST", "/push/devices", "x".repeat(5000)), 400)).code).toBe("VALIDATION_FAILED");
  });

  it("refuse a fourth device", async () => {
    await confirmNow();
    for (const host of ["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"]) {
      expect((await api("POST", "/push/devices", await subscription(host))).status).toBe(201);
    }
    const full = await refusal(await api("POST", "/push/devices", await subscription("wns2-bn3p.notify.windows.com")), 409);
    expect(full.message).toBe("Até 3 aparelhos podem receber avisos. Remova um antes de adicionar este.");
  });

  it("remove a device only with the password typed recently", async () => {
    await confirmNow();
    const { device } = await json<{ device: PushDevice }>(await api("POST", "/push/devices", await subscription()), 201);
    await confirmedLongAgo();
    expect((await refusal(await api("DELETE", `/push/devices/${device.id}`), 403)).code).toBe("RECENT_AUTH_REQUIRED");
    await confirmNow();
    expect((await api("DELETE", `/push/devices/${device.id}`)).status).toBe(204);
    expect((await refusal(await api("DELETE", `/push/devices/${device.id}`), 404)).code).toBe("NOT_FOUND");
    expect((await refusal(await api("DELETE", "/push/devices/nao-e-um-id"), 404)).code).toBe("NOT_FOUND");
  });

  it("mark the asking browser's own device, and keep it while that browser opens the app", async () => {
    await confirmNow();
    const { device } = await json<{ device: PushDevice }>(await api("POST", "/push/devices", await subscription(), true), 201);
    expect(device.current).toBe(true);
    expect((await json<PushStatus>(await api("GET", "/push", undefined, true), 200)).devices.map((d) => d.current)).toEqual([true]);
    // Without the device cookie (another browser) it isn't this one.
    expect((await json<PushStatus>(await api("GET", "/push"), 200)).devices.map((d) => d.current)).toEqual([false]);
    const lastSeen = () => inOwner((agent) => agent.store.db.one<{ at: string }>(`SELECT last_seen_at AS at FROM zur_push_devices`)?.at ?? "");
    await inOwner((agent) => agent.store.db.run(`UPDATE zur_push_devices SET last_seen_at = '2026-01-01T00:00:00.000Z'`));
    // A session check from another browser leaves it; from its own browser it moves.
    expect((await api("GET", "/auth/session")).status).toBe(200);
    expect(await lastSeen()).toBe("2026-01-01T00:00:00.000Z");
    expect((await api("GET", "/auth/session", undefined, true)).status).toBe(200);
    expect((await lastSeen()) > "2026-01-01T00:00:00.000Z").toBe(true);
  });

  it("send a test notice to the devices, posting only to their push service", async () => {
    expect((await refusal(await api("POST", "/push/test"), 409)).code).toBe("CONFLICT");
    await confirmNow();
    const sub = await subscription();
    await json(await api("POST", "/push/devices", sub), 201);
    // The device's own alert went to it first.
    await inOwner((agent) => agent.store.alerts.settled());
    expect(pushed).toEqual([sub.endpoint]);
    expect(await json(await api("POST", "/push/test"), 200)).toEqual({ sent: true });
    expect(pushed).toEqual([sub.endpoint, sub.endpoint]);
  });

  it("drop a device quiet for seven days on the shared alarm", async () => {
    await confirmNow();
    await json(await api("POST", "/push/devices", await subscription()), 201);
    await inOwner(async (agent) => {
      agent.store.db.run(`UPDATE zur_push_devices SET last_seen_at = ?`, new Date(Date.now() - 8 * 24 * 3_600_000).toISOString());
      await agent.runAutomations({});
      expect(agent.store.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_push_devices`)?.n).toBe(0);
    });
  });
});
