import { fromBase64Url, type Notice, PUSH_LIMITS, type PushPayload, toBase64Url } from "@zuri/shared";
import { describe, expect, it } from "vitest";
import type { ClientInfo } from "../src/auth/client.ts";
import { AuthEvents } from "../src/auth/events.ts";
import { InternalState } from "../src/db/internal-state.ts";
import { AppError } from "../src/http/errors.ts";
import { PushChannel } from "../src/push/channel.ts";
import { PushDevices } from "../src/push/devices.ts";
import { PushService } from "../src/push/service.ts";
import { type ChatWorld, withChatWorld } from "./chat-world.ts";
import { testEnv } from "./helpers.ts";

// Web Push devices, the channel and Settings > Notices' push part (step 11b),
// against the real database and a fake push service that decrypts what it gets.

const DAY = 24 * 3_600_000;
const KEYS = { publicKey: testEnv.VAPID_PUBLIC_KEY ?? "", privateKey: testEnv.VAPID_PRIVATE_KEY ?? "" };
const CLIENT: ClientInfo = {
  network: "192.0.2.10",
  ip: "192.0.2.10",
  userAgent: "Mozilla/5.0 (Linux; Android 15) Chrome/140.0 Mobile Safari/537.36",
  geo: { country: "BR", region: "SP", city: "São Paulo", asn: null, colo: "GRU" },
};

/** A browser's subscription with its own keys, so the fake push service can open what arrives. */
async function browser(host = "fcm.googleapis.com") {
  const keys = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const p256dh = toBase64Url(new Uint8Array((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer));
  return { keys, auth, subscription: { endpoint: `https://${host}/fcm/send/${crypto.randomUUID()}`, keys: { p256dh, auth: toBase64Url(auth) } } };
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

/** What the browser does on arrival (RFC 8291), short form: push-webpush.test.ts checks it step by step. */
async function open(body: Uint8Array, keys: CryptoKeyPair, auth: Uint8Array): Promise<PushPayload> {
  const enc = new TextEncoder();
  const salt = body.slice(0, 16);
  const asPublic = body.slice(21, 86);
  const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const derive = { name: "ECDH", public: asKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const shared = new Uint8Array(await crypto.subtle.deriveBits(derive, keys.privateKey, 256));
  const uaPublic = new Uint8Array((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer);
  const ikm = await hmac(await hmac(auth, shared), new Uint8Array([...enc.encode("WebPush: info\0"), ...uaPublic, ...asPublic, 1]));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, new Uint8Array([...enc.encode("Content-Encoding: aes128gcm\0"), 1]))).slice(0, 16);
  const nonce = (await hmac(prk, new Uint8Array([...enc.encode("Content-Encoding: nonce\0"), 1]))).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, body.slice(86)));
  return JSON.parse(new TextDecoder().decode(padded.slice(0, -1))) as PushPayload;
}

interface Posted {
  url: string;
  headers: Headers;
  body: Uint8Array;
  redirect: RequestRedirect | undefined;
}

/** A push service that answers each endpoint as told (201 by default) and keeps what it got. */
function pushService() {
  const posted: Posted[] = [];
  const answers = new Map<string, number | "throw">();
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    posted.push({ url, headers: new Headers(init?.headers), body: new Uint8Array(init?.body as ArrayBuffer), redirect: init?.redirect });
    const answer = answers.get(url) ?? 201;
    if (answer === "throw") throw new TypeError("network");
    return new Response(answer === 201 ? null : "nope", { status: answer });
  }) as typeof fetch;
  return { posted, answers, fetcher };
}

interface PushWorld {
  world: ChatWorld;
  devices: PushDevices;
  service: PushService;
  channel: PushChannel;
  net: ReturnType<typeof pushService>;
  keys: { current: typeof KEYS | null };
}

function withPush<T>(fn: (w: PushWorld) => T | Promise<T>): Promise<T> {
  return withChatWorld(async (world) => {
    const clock = () => world.clock.now;
    const devices = new PushDevices(world.db, clock);
    const state = new InternalState(world.db);
    const net = pushService();
    const keys: PushWorld["keys"] = { current: KEYS };
    const service = new PushService({
      devices,
      state,
      events: new AuthEvents(world.db, state, clock),
      keys: () => keys.current,
      subject: () => "https://zuri.exemplo.com.br",
      locale: () => "pt-BR",
      fetcher: net.fetcher,
      clock,
    });
    return fn({ world, devices, service, channel: service.channel, net, keys });
  });
}

function notice(overrides: Partial<Notice> = {}): Notice {
  return {
    id: crypto.randomUUID(),
    kind: "automation.result",
    category: "reminders",
    priority: "normal",
    title: "Água",
    body: "Beber um copo de água",
    link: "/automacoes",
    createdAt: new Date().toISOString(),
    readAt: null,
    escalation: null,
    attempts: 0,
    nextAttemptAt: null,
    security: false,
    ...overrides,
  };
}

async function refusal(work: () => unknown): Promise<AppError> {
  try {
    await work();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

const events = (w: PushWorld) => w.world.db.all<{ kind: string; alert: number }>(`SELECT kind, alert_pending AS alert FROM zur_auth_events WHERE kind LIKE 'push_%' ORDER BY rowid`);

describe("push devices", () => {
  it("keeps three at most, and the same browser subscribing again only renews its keys", async () => {
    await withPush(async (w) => {
      const a = await browser();
      const first = w.devices.add(a.subscription, CLIENT.userAgent);
      expect(first.created).toBe(true);
      expect(first.device).toMatchObject({ userAgent: CLIENT.userAgent, lastSentAt: null });
      const again = w.devices.add({ ...a.subscription, keys: (await browser()).subscription.keys }, "outro");
      expect(again).toMatchObject({ created: false, device: { id: first.device.id, userAgent: CLIENT.userAgent } });
      w.devices.add((await browser("updates.push.services.mozilla.com")).subscription, "b");
      w.devices.add((await browser("web.push.apple.com")).subscription, "c");
      expect(w.devices.count()).toBe(PUSH_LIMITS.maxDevices);
      const full = await refusal(async () => w.devices.add((await browser()).subscription, "d"));
      expect(full).toMatchObject({ code: "CONFLICT", messageKey: "error.pushDeviceLimit" });
      expect(w.devices.count()).toBe(3);
      // The list never carries the endpoint or the keys.
      expect(JSON.stringify(w.devices.list())).not.toContain("fcm.googleapis.com");
    });
  });

  it("drops a device seven days after it last opened the app, not a moment before", async () => {
    await withPush(async (w) => {
      const a = (await browser()).subscription;
      const b = (await browser()).subscription;
      w.devices.add(a, "a");
      w.devices.add(b, "b");
      w.world.clock.now += PUSH_LIMITS.staleMs - 1000;
      w.devices.seen(b.endpoint);
      // Unknown endpoints change nothing.
      w.devices.seen("https://fcm.googleapis.com/fcm/send/desconhecido");
      w.world.clock.now += 1000;
      expect(w.devices.pruneStale()).toBe(0);
      w.world.clock.now += 1;
      expect(w.devices.pruneStale()).toBe(1);
      expect(w.devices.list().map((d) => d.userAgent)).toEqual(["b"]);
      expect(w.devices.removeEndpoint(b.endpoint)).toBe(true);
      expect(w.devices.count()).toBe(0);
    });
  });
});

describe("the push channel", () => {
  it("is not configured without keys, has no target without devices, and is ready with one", async () => {
    await withPush(async (w) => {
      w.keys.current = null;
      expect(w.channel.state()).toBe("not_configured");
      expect(await w.channel.send({ notice: notice(), attempt: 1 })).toEqual({ status: "skipped", reason: "not_configured" });
      w.keys.current = KEYS;
      expect(w.channel.state()).toBe("no_target");
      expect(await w.channel.send({ notice: notice(), attempt: 1 })).toEqual({ status: "skipped", reason: "no_target" });
      w.devices.add((await browser()).subscription, "a");
      expect(w.channel.state()).toBe("ready");
      expect(w.net.posted).toHaveLength(0);
    });
  });

  it("posts one encrypted, signed message per device that only that device opens", async () => {
    await withPush(async (w) => {
      const a = await browser();
      const b = await browser("updates.push.services.mozilla.com");
      w.devices.add(a.subscription, "a");
      w.devices.add(b.subscription, "b");
      const sent = notice({ priority: "critical", category: "security", security: true, link: "/acessos" });
      expect(await w.channel.send({ notice: sent, attempt: 1 })).toEqual({ status: "sent" });
      expect(w.net.posted.map((p) => p.url).sort()).toEqual([a.subscription.endpoint, b.subscription.endpoint].sort());
      for (const post of w.net.posted) {
        expect(post.headers.get("content-encoding")).toBe("aes128gcm");
        expect(post.headers.get("ttl")).toBe(String(PUSH_LIMITS.ttlSeconds));
        expect(post.headers.get("urgency")).toBe("high");
        expect(post.headers.get("authorization")).toMatch(new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${KEYS.publicKey}$`));
        expect(post.redirect).toBe("manual");
        // Nothing readable on the wire.
        expect(new TextDecoder().decode(post.body)).not.toContain("Água");
      }
      const toA = w.net.posted.find((p) => p.url === a.subscription.endpoint);
      expect(await open(toA?.body ?? new Uint8Array(), a.keys, a.auth)).toEqual({ id: sent.id, title: "Água", body: "Beber um copo de água", link: "/acessos", sticky: true });
      await expect(open(toA?.body ?? new Uint8Array(), b.keys, b.auth)).rejects.toThrow();
      expect(w.devices.list().every((d) => d.lastSentAt !== null)).toBe(true);
    });
  });

  it("clips long text, drops a link outside the app and marks low priority as such", async () => {
    await withPush(async (w) => {
      const a = await browser();
      w.devices.add(a.subscription, "a");
      await w.channel.send({ notice: notice({ title: "T".repeat(500), body: "🙂".repeat(5000), link: "https://exemplo.com.br/x", priority: "low" }), attempt: 1 });
      const post = w.net.posted[0];
      expect(post?.headers.get("urgency")).toBe("low");
      const payload = await open(post?.body ?? new Uint8Array(), a.keys, a.auth);
      expect([...payload.title]).toHaveLength(PUSH_LIMITS.titleMax);
      expect([...payload.body]).toHaveLength(PUSH_LIMITS.bodyMax);
      expect(payload.body.endsWith("…")).toBe(true);
      expect(payload).toMatchObject({ link: null, sticky: false });
    });
  });

  it("drops a device whose subscription is gone, and tells refusals from an unreachable service", async () => {
    await withPush(async (w) => {
      const gone = (await browser()).subscription;
      const busy = (await browser()).subscription;
      w.devices.add(gone, "gone");
      w.devices.add(busy, "busy");
      w.net.answers.set(gone.endpoint, 410);
      w.net.answers.set(busy.endpoint, 503);
      expect(await w.channel.send({ notice: notice(), attempt: 1 })).toEqual({ status: "failed", reason: "unreachable" });
      expect(w.devices.list().map((d) => d.userAgent)).toEqual(["busy"]);
      w.net.answers.set(busy.endpoint, 400);
      expect(await w.channel.send({ notice: notice(), attempt: 1 })).toEqual({ status: "failed", reason: "error" });
      w.net.answers.set(busy.endpoint, "throw");
      expect(await w.channel.send({ notice: notice(), attempt: 1 })).toEqual({ status: "failed", reason: "unreachable" });
      w.net.answers.set(busy.endpoint, 404);
      expect(await w.channel.send({ notice: notice(), attempt: 1 })).toEqual({ status: "skipped", reason: "no_target" });
      expect(w.devices.count()).toBe(0);
    });
  });

  it("counts as sent when one device took it, even if another failed", async () => {
    await withPush(async (w) => {
      const ok = (await browser()).subscription;
      const bad = (await browser()).subscription;
      w.devices.add(ok, "ok");
      w.devices.add(bad, "bad");
      w.net.answers.set(bad.endpoint, 500);
      expect(await w.channel.send({ notice: notice(), attempt: 1 })).toEqual({ status: "sent" });
    });
  });
});

describe("Settings > Notices, push part", () => {
  it("shows the public key and the devices, never the endpoints", async () => {
    await withPush(async (w) => {
      expect(w.service.status()).toEqual({ publicKey: KEYS.publicKey, devices: [], max: 3 });
      w.service.add((await browser()).subscription, CLIENT, "s".repeat(64));
      const status = w.service.status();
      expect(status.devices).toHaveLength(1);
      expect(JSON.stringify(status)).not.toMatch(/fcm|p256dh|auth/);
      w.keys.current = null;
      expect(w.service.status().publicKey).toBeNull();
    });
  });

  it("adding and removing a device are access events that alert the owner; renewing and forgetting are not", async () => {
    await withPush(async (w) => {
      const a = (await browser()).subscription;
      const device = w.service.add(a, CLIENT, "s".repeat(64));
      w.service.add(a, CLIENT, "s".repeat(64));
      w.service.remove(device.id, CLIENT, "s".repeat(64));
      expect(events(w)).toEqual([
        { kind: "push_added", alert: 1 },
        { kind: "push_removed", alert: 1 },
      ]);
      expect((await refusal(() => w.service.remove(device.id, CLIENT, "s".repeat(64)))).code).toBe("NOT_FOUND");
      const b = (await browser()).subscription;
      w.service.add(b, CLIENT, "s".repeat(64));
      w.service.forget(b.endpoint);
      expect(w.devices.count()).toBe(0);
      expect(events(w).map((e) => e.kind)).toEqual(["push_added", "push_removed", "push_added"]);
    });
  });

  it("refuses a device while push isn't set up", async () => {
    await withPush(async (w) => {
      w.keys.current = null;
      const error = await refusal(async () => w.service.add((await browser()).subscription, CLIENT, "s".repeat(64)));
      expect(error).toMatchObject({ code: "NOT_CONFIGURED", messageKey: "error.pushNotConfigured" });
      expect((await refusal(() => w.service.test())).code).toBe("NOT_CONFIGURED");
    });
  });

  it("sends a test notice three times an hour, in the owner's language", async () => {
    await withPush(async (w) => {
      expect(await refusal(() => w.service.test())).toMatchObject({ code: "CONFLICT", messageKey: "error.pushNoDevice" });
      const a = await browser();
      w.service.add(a.subscription, CLIENT, "s".repeat(64));
      // The refused try above counted too: two left.
      expect(await w.service.test()).toEqual({ sent: true });
      expect(await w.service.test()).toEqual({ sent: true });
      const limited = await refusal(() => w.service.test());
      expect(limited.code).toBe("RATE_LIMITED");
      expect(limited.details?.retryAfter).toBe(3600);
      const payload = await open(w.net.posted[0]?.body ?? new Uint8Array(), a.keys, a.auth);
      expect(payload).toMatchObject({ title: "Teste da Zuri", link: "/configuracoes/avisos", sticky: false });
      w.world.clock.now += 3_600_000;
      w.net.answers.set(a.subscription.endpoint, 500);
      expect(await w.service.test()).toEqual({ sent: false });
    });
  });

  it("prunes quiet devices from the wake", async () => {
    await withPush(async (w) => {
      w.service.add((await browser()).subscription, CLIENT, "s".repeat(64));
      w.world.clock.now += 8 * DAY;
      w.service.prune();
      expect(w.devices.count()).toBe(0);
    });
  });
});

describe("the subscription keys", () => {
  it("round-trip through base64url as the browser sends them", async () => {
    const { subscription } = await browser();
    expect(fromBase64Url(subscription.keys.p256dh)).toHaveLength(65);
    expect(fromBase64Url(subscription.keys.auth)).toHaveLength(16);
  });
});
