import { AGENT_INSTANCE_NAME, BREACH_API, MIN_BREACH_LINES, PUSH_LIMITS, toBase64Url } from "@zuri/shared";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import { call, CSRF, HUMAN_TOKEN, ORIGIN, TEST_EMAIL, TEST_PASSWORD, testEnv } from "./helpers.ts";

// What happens to the push devices when the session ends or the password
// changes (step 11b, security audit): "Sair" drops this browser's device, the
// interface's own sign-out after idle time keeps it, and a password change
// retires every device only after the alert about it went out to them.

const owner = () => testEnv.AGENT.get(testEnv.AGENT.idFromName(AGENT_INSTANCE_NAME));
const inOwner = <T>(fn: (agent: ZuriAgent) => T | Promise<T>) => runInDurableObject(owner(), (agent: ZuriAgent) => fn(agent));
const base = { ...CSRF, "content-type": "application/json", "cf-connecting-ip": "192.0.2.191", "user-agent": "Mozilla/5.0 (Linux; Android 15) Chrome/140.0 Mobile Safari/537.36" };

let password = TEST_PASSWORD;
const pushed: string[] = [];

beforeEach(() => {
  pushed.length = 0;
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://fcm.googleapis.com/")) {
      pushed.push(url);
      return new Response(null, { status: 201 });
    }
    if (url.startsWith(BREACH_API)) {
      return new Response(Array.from({ length: MIN_BREACH_LINES }, (_, i) => `${i.toString(16).toUpperCase().padStart(35, "0")}:0`).join("\n"));
    }
    return real(input, init);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await inOwner((agent) => agent.store.db.run(`DELETE FROM zur_push_devices`));
});

/** Signs in, confirms the password and activates push in this browser. */
async function signedInWithPush(): Promise<{ cookie: string; device: string }> {
  const res = await call(`${ORIGIN}/api/auth/login`, { method: "POST", headers: base, body: JSON.stringify({ email: TEST_EMAIL, password, turnstileToken: HUMAN_TOKEN }) });
  expect(res.status, await res.clone().text()).toBe(200);
  const set = res.headers.getSetCookie();
  const session = set.find((c) => c.startsWith("__Host-zuri_session="))?.split(";")[0] ?? "";
  const deviceCookie = set.find((c) => c.startsWith("__Host-zuri_device="))?.split(";")[0] ?? "";
  const cookie = `${session}; ${deviceCookie}`;
  const keys = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const subscription = {
    endpoint: `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`,
    keys: {
      p256dh: toBase64Url(new Uint8Array((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer)),
      auth: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    },
  };
  const added = await call(`${ORIGIN}/api/push/devices`, { method: "POST", headers: { ...base, cookie }, body: JSON.stringify(subscription) });
  expect(added.status, await added.clone().text()).toBe(201);
  const { device } = (await added.json()) as { device: { id: string } };
  await inOwner((agent) => agent.store.alerts.settled());
  return { cookie, device: device.id };
}

const rows = () => inOwner((agent) => agent.store.db.all<{ id: string; retired_at: string | null }>(`SELECT id, retired_at FROM zur_push_devices`));

describe("push devices and the end of a session", () => {
  it("the interface signing out by itself keeps this browser's device", async () => {
    const { cookie, device } = await signedInWithPush();
    expect((await call(`${ORIGIN}/api/auth/logout`, { method: "POST", headers: { ...base, cookie } })).status).toBe(204);
    expect(await rows()).toEqual([{ id: device, retired_at: null }]);
  });

  it("the owner's own Sair drops this browser's device", async () => {
    const { cookie } = await signedInWithPush();
    expect((await call(`${ORIGIN}/api/auth/logout?manual=1`, { method: "POST", headers: { ...base, cookie } })).status).toBe(204);
    expect(await rows()).toEqual([]);
  });
});

describe("push devices and a password change", () => {
  it("the alert about the change still reaches every device, which then stop receiving", async () => {
    const { cookie, device } = await signedInWithPush();
    const next = "outra senha bem longa e nova de teste";
    const changed = await call(`${ORIGIN}/api/auth/password`, { method: "POST", headers: { ...base, cookie }, body: JSON.stringify({ currentPassword: password, newPassword: next }) });
    expect(changed.status, await changed.clone().text()).toBe(200);
    password = next;
    const deliveries = await inOwner(async (agent) => {
      await agent.store.alerts.settled();
      return agent.store.db.all<{ channel: string; status: string }>(
        `SELECT d.channel AS channel, d.status AS status FROM zur_alert_deliveries d JOIN zur_notices n ON n.id = d.notice_id WHERE n.params LIKE '%password_changed%'`,
      );
    });
    // E-mail isn't set up in the tests: it says so, and the push still gets the alert.
    expect(deliveries).toEqual([{ channel: "push", status: "sent" }, { channel: "email", status: "skipped" }]);
    pushed.length = 0;
    // Retired: hidden from the list, out of the three, gone at the next prune after the grace.
    const [row] = await rows();
    expect(row?.id).toBe(device);
    expect(row?.retired_at).not.toBeNull();
    const after = await inOwner(async (agent) => {
      const seen = agent.store.push.status(null).devices.length;
      const ordinary = await agent.store.push.channel.broadcast({ id: "x", title: "t", body: "b", link: null, sticky: false });
      agent.store.db.run(`UPDATE zur_push_devices SET retired_at = ?`, new Date(Date.now() - PUSH_LIMITS.retiredGraceMs - 1).toISOString());
      agent.store.push.prune();
      return { seen, ordinary, left: agent.store.db.all(`SELECT id FROM zur_push_devices`).length };
    });
    expect(after).toEqual({ seen: 0, ordinary: { status: "skipped", reason: "no_target" }, left: 0 });
    expect(pushed).toEqual([]);
  });
});
