import { fromBase64Url, type Notice, PUSH_LIMITS, type PushPayload, toBase64Url } from "@zuri/shared";
import { describe, expect, it } from "vitest";
import type { ClientInfo } from "../src/auth/client.ts";
import { AuthEvents } from "../src/auth/events.ts";
import { InternalState } from "../src/db/internal-state.ts";
import { AppError } from "../src/http/errors.ts";
import { PUSH_BURST, type PushChannel } from "../src/push/channel.ts";
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
  redirect: RequestInit["redirect"];
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
    ackInApp: false,
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
      const first = w.devices.add(a.subscription, CLIENT.userAgent, "b1");
      expect(first.created).toBe(true);
      expect(first.device).toMatchObject({ userAgent: CLIENT.userAgent, lastSentAt: null, current: true });
      const again = w.devices.add({ ...a.subscription, keys: (await browser()).subscription.keys }, "outro", null);
      expect(again).toMatchObject({ created: false, device: { id: first.device.id, userAgent: CLIENT.userAgent, current: false } });
      w.world.clock.now += 1000;
      w.devices.add((await browser("updates.push.services.mozilla.com")).subscription, "b", "b2");
      w.world.clock.now += 1000;
      w.devices.add((await browser("web.push.apple.com")).subscription, "c", null);
      expect(w.devices.count()).toBe(PUSH_LIMITS.maxDevices);
      const full = await refusal(async () => w.devices.add((await browser()).subscription, "d", "b4"));
      expect(full).toMatchObject({ code: "CONFLICT", messageKey: "error.pushDeviceLimit" });
      expect(w.devices.count()).toBe(3);
      // Renewing without a browser id kept the first one's; each browser sees only its own as current.
      expect(w.devices.list("b1").map((d) => d.current)).toEqual([true, false, false]);
      expect(w.devices.list("b2").map((d) => d.current)).toEqual([false, true, false]);
      expect(w.devices.list(null).some((d) => d.current)).toBe(false);
      // The list never carries the endpoint, the keys or the browser id.
      expect(JSON.stringify(w.devices.list("b1"))).not.toMatch(/fcm\.googleapis|b1"/);
    });
  });

  it("drops a device only after seven full days without its browser opening the app", async () => {
    await withPush(async (w) => {
      const added = w.world.clock.now;
      w.devices.add((await browser()).subscription, "a", "ba");
      w.devices.add((await browser()).subscription, "b", "bb");
      // Opened again within the day: "last seen" doesn't move (one write a day),
      // so the cut adds that day and still never comes before seven days of quiet.
      w.world.clock.now = added + 0.9 * PUSH_LIMITS.seenEveryMs;
      w.devices.seen("ba");
      w.world.clock.now = added + PUSH_LIMITS.staleMs - 1000;
      w.devices.seen("bb");
      // Unknown browsers change nothing.
      w.devices.seen("desconhecido");
      w.world.clock.now = added + 0.9 * PUSH_LIMITS.seenEveryMs + PUSH_LIMITS.staleMs;
      expect(w.devices.pruneStale()).toBe(0);
      w.world.clock.now = added + PUSH_LIMITS.staleMs + PUSH_LIMITS.seenEveryMs;
      expect(w.devices.pruneStale()).toBe(0);
      w.world.clock.now += 1;
      expect(w.devices.pruneStale()).toBe(1);
      expect(w.devices.list(null).map((d) => d.userAgent)).toEqual(["b"]);
    });
  });

  it("moves the last time seen at most once a day", async () => {
    await withPush(async (w) => {
      w.devices.add((await browser()).subscription, "a", "ba");
      const at = () => w.devices.list(null)[0]?.lastSeenAt;
      const added = at();
      w.world.clock.now += PUSH_LIMITS.seenEveryMs;
      w.devices.seen("ba");
      expect(at()).toBe(added);
      w.world.clock.now += 1;
      w.devices.seen("ba");
      expect(at()).toBe(new Date(w.world.clock.now).toISOString());
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
      w.devices.add((await browser()).subscription, "a", null);
      expect(w.channel.state()).toBe("ready");
      expect(w.net.posted).toHaveLength(0);
    });
  });

  it("posts one encrypted, signed message per device that only that device opens", async () => {
    await withPush(async (w) => {
      const a = await browser();
      const b = await browser("updates.push.services.mozilla.com");
      w.devices.add(a.subscription, "a", null);
      w.devices.add(b.subscription, "b", null);
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
        expect(new TextDecoder().decode(post.body)).not.toContain("Zuri");
      }
      const toA = w.net.posted.find((p) => p.url === a.subscription.endpoint);
      expect(await open(toA?.body ?? new Uint8Array(), a.keys, a.auth)).toEqual({ id: sent.id, title: "Zuri", body: "Você tem um aviso importante. Abra o app para ver.", link: "/acessos", sticky: true });
      await expect(open(toA?.body ?? new Uint8Array(), b.keys, b.auth)).rejects.toThrow();
      expect(w.devices.list(null).every((d) => d.lastSentAt !== null)).toBe(true);
    });
  });

  it("is always discreet: the notice's title and text never leave the server, and a link outside the app is dropped", async () => {
    await withPush(async (w) => {
      const a = await browser();
      w.devices.add(a.subscription, "a", null);
      await w.channel.send({ notice: notice({ title: "Consulta no médico", body: "Levar os exames de sangue", link: "https://exemplo.com.br/x", priority: "low" }), attempt: 1 });
      const post = w.net.posted[0];
      expect(post?.headers.get("urgency")).toBe("low");
      const payload = await open(post?.body ?? new Uint8Array(), a.keys, a.auth);
      expect(payload).toMatchObject({ title: "Zuri", body: "Você tem um aviso novo. Abra o app para ver.", link: null, sticky: false });
      expect(JSON.stringify(payload)).not.toMatch(/médico|exames/);
    });
  });

  it("posts at most 30 times in 30 seconds, so a burst never runs out of subrequests", async () => {
    await withPush(async (w) => {
      for (let i = 0; i < 3; i++) w.devices.add((await browser()).subscription, `d${i}`, null);
      for (let i = 0; i < PUSH_BURST.posts / 3; i++) expect(await w.channel.send({ notice: notice(), attempt: 1 })).toEqual({ status: "sent" });
      expect(await w.channel.send({ notice: notice(), attempt: 1 })).toEqual({ status: "skipped", reason: "channel_limit" });
      expect(w.net.posted).toHaveLength(PUSH_BURST.posts);
      w.world.clock.now += PUSH_BURST.windowMs - 1;
      expect(await w.channel.send({ notice: notice(), attempt: 1 })).toEqual({ status: "skipped", reason: "channel_limit" });
      // Security alerts keep a reserve: three more of them still go out, then none.
      const alert = () => notice({ priority: "critical", category: "security", security: true });
      for (let i = 0; i < (PUSH_BURST.securityPosts - PUSH_BURST.posts) / 3; i++) expect(await w.channel.send({ notice: alert(), attempt: 1 })).toEqual({ status: "sent" });
      expect(await w.channel.send({ notice: alert(), attempt: 1 })).toEqual({ status: "skipped", reason: "channel_limit" });
      expect(w.net.posted).toHaveLength(PUSH_BURST.securityPosts);
      // The first 30 leave the window; the 9 of the reserve still count.
      w.world.clock.now += 1;
      expect(await w.channel.send({ notice: notice(), attempt: 1 })).toEqual({ status: "sent" });
      expect(w.net.posted).toHaveLength(PUSH_BURST.securityPosts + 3);
    });
  });

  it("drops a device whose subscription is gone, and tells refusals from an unreachable service", async () => {
    await withPush(async (w) => {
      const gone = (await browser()).subscription;
      const busy = (await browser()).subscription;
      w.devices.add(gone, "gone", null);
      w.devices.add(busy, "busy", null);
      w.net.answers.set(gone.endpoint, 410);
      w.net.answers.set(busy.endpoint, 503);
      expect(await w.channel.send({ notice: notice(), attempt: 1 })).toEqual({ status: "failed", reason: "unreachable" });
      expect(w.devices.list(null).map((d) => d.userAgent)).toEqual(["busy"]);
      w.net.answers.set(busy.endpoint, 400);
      expect(await w.channel.send({ notice: notice(), attempt: 1 })).toEqual({ status: "failed", reason: "error" });
      w.net.answers.set(busy.endpoint, "throw");
      expect(await w.channel.send({ notice: notice(), attempt: 1 })).toEqual({ status: "failed", reason: "unreachable" });
      // 403: made with another VAPID pair (the owner changed it); it never works again.
      w.net.answers.set(busy.endpoint, 403);
      expect(await w.channel.send({ notice: notice(), attempt: 1 })).toEqual({ status: "skipped", reason: "no_target" });
      expect(w.devices.count()).toBe(0);
    });
  });

  it("counts as sent when one device took it, even if another failed", async () => {
    await withPush(async (w) => {
      const ok = (await browser()).subscription;
      const bad = (await browser()).subscription;
      w.devices.add(ok, "ok", null);
      w.devices.add(bad, "bad", null);
      w.net.answers.set(bad.endpoint, 500);
      expect(await w.channel.send({ notice: notice(), attempt: 1 })).toEqual({ status: "sent" });
    });
  });
});

describe("Settings > Notices, push part", () => {
  it("shows the public key and the devices, never the endpoints", async () => {
    await withPush(async (w) => {
      expect(w.service.status(null)).toEqual({ publicKey: KEYS.publicKey, devices: [], max: 3 });
      await w.service.add((await browser()).subscription, CLIENT, "s".repeat(64), "este");
      const status = w.service.status("este");
      expect(status.devices).toMatchObject([{ current: true }]);
      expect(JSON.stringify(status)).not.toMatch(/fcm|p256dh|auth|este/);
      w.keys.current = null;
      expect(w.service.status(null).publicKey).toBeNull();
    });
  });

  it("adding and removing a device are access events that alert the owner; renewing is not", async () => {
    await withPush(async (w) => {
      const a = (await browser()).subscription;
      const device = await w.service.add(a, CLIENT, "s".repeat(64), null);
      await w.service.add(a, CLIENT, "s".repeat(64), null);
      w.service.remove(device.id, CLIENT, "s".repeat(64));
      expect(events(w)).toEqual([
        { kind: "push_added", alert: 1 },
        { kind: "push_removed", alert: 1 },
      ]);
      expect((await refusal(() => w.service.remove(device.id, CLIENT, "s".repeat(64)))).code).toBe("NOT_FOUND");
    });
  });

  it("refuses a device while push isn't set up", async () => {
    await withPush(async (w) => {
      w.keys.current = null;
      const error = await refusal(async () => w.service.add((await browser()).subscription, CLIENT, "s".repeat(64), null));
      expect(error).toMatchObject({ code: "NOT_CONFIGURED", messageKey: "error.pushNotConfigured" });
      expect((await refusal(() => w.service.test())).code).toBe("NOT_CONFIGURED");
    });
  });

  it("sends a test notice three times an hour, in the owner's language", async () => {
    await withPush(async (w) => {
      expect(await refusal(() => w.service.test())).toMatchObject({ code: "CONFLICT", messageKey: "error.pushNoDevice" });
      const a = await browser();
      await w.service.add(a.subscription, CLIENT, "s".repeat(64), null);
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

  it("keeps a device its browser opens, and prunes quiet ones from the wake", async () => {
    await withPush(async (w) => {
      await w.service.add((await browser()).subscription, CLIENT, "s".repeat(64), "usado");
      await w.service.add((await browser()).subscription, CLIENT, "s".repeat(64), "esquecido");
      w.world.clock.now += 6 * DAY;
      w.service.seen("usado");
      w.world.clock.now += 2 * DAY + 1;
      w.service.prune();
      expect(w.devices.count()).toBe(1);
      expect(w.service.status("usado").devices).toMatchObject([{ current: true }]);
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

describe("local development", () => {
  it("answers every post as a push service would, without the network", async () => {
    const { developmentPushFetcher } = await import("../src/push/dev-push.ts");
    const res = await developmentPushFetcher("https://fcm.googleapis.com/fcm/send/x", { method: "POST", body: new Uint8Array([1, 2, 3]) });
    expect(res.status).toBe(201);
    expect((await developmentPushFetcher("https://fcm.googleapis.com/fcm/send/x")).status).toBe(201);
  });
});
