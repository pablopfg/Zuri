import { AGENT_INSTANCE_NAME, AREAS, LIVE_CLOSE, LIVE_LIMITS, LIVE_PATH, type AreaVersions } from "@zuri/shared";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import { LIVE_TAG } from "../src/live/channel.ts";
import { call, CSRF, errorBody, HUMAN_TOKEN, ORIGIN, TEST_EMAIL, TEST_PASSWORD, testEnv } from "./helpers.ts";

// Nova UI, PR 3: the live channel. One WebSocket per browser, held while the
// object hibernates, that only writes the areas' numbers when one moved. It
// opens like any API request (a live session) plus the site's Origin, and it
// closes as soon as the session, a lockdown or a gate says so.

const IP = "192.0.2.150";
let cookie = "";
const opened: WebSocket[] = [];

function inOwner<T>(fn: (agent: ZuriAgent, state: DurableObjectState) => T | Promise<T>): Promise<T> {
  const stub = testEnv.AGENT.get(testEnv.AGENT.idFromName(AGENT_INSTANCE_NAME));
  return runInDurableObject(stub, fn);
}

const apiHeaders = () => ({
  ...CSRF,
  "content-type": "application/json",
  "cf-connecting-ip": IP,
  "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0 Safari/537.36",
  cookie,
});

function api(method: string, path: string, body?: unknown) {
  return call(`${ORIGIN}/api${path}`, { method, headers: apiHeaders(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

async function signIn() {
  const res = await call(`${ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: { ...apiHeaders(), cookie: "" },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD, turnstileToken: HUMAN_TOKEN }),
  });
  expect(res.status).toBe(200);
  cookie = res.headers.getSetCookie().find((c) => c.startsWith("__Host-zuri_session="))?.split(";")[0] ?? "";
}

/** The upgrade as a browser on the site sends it; `headers` replace or drop (null) any of them. */
function upgrade(headers: Record<string, string | null> = {}, init: { method?: string; path?: string } = {}) {
  const base: Record<string, string> = {
    upgrade: "websocket",
    connection: "Upgrade",
    "sec-websocket-version": "13",
    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    origin: ORIGIN,
    "cf-connecting-ip": IP,
    cookie,
  };
  for (const [name, value] of Object.entries(headers)) {
    if (value === null) delete base[name];
    else base[name] = value;
  }
  return call(`${ORIGIN}${init.path ?? LIVE_PATH}`, { method: init.method ?? "GET", headers: base });
}

/** An open channel and what it receives, in order. */
interface Channel {
  ws: WebSocket;
  messages: string[];
  closed: Promise<{ code: number }>;
  /** The next message not read yet. */
  next(): Promise<string>;
}

let cursor = new WeakMap<WebSocket, number>();

async function open(headers: Record<string, string | null> = {}): Promise<Channel> {
  const res = await upgrade(headers);
  expect(res.status, res.status === 101 ? "" : await res.clone().text()).toBe(101);
  const ws = res.webSocket;
  if (!ws) throw new Error("no socket");
  const messages: string[] = [];
  const waiting: (() => void)[] = [];
  ws.addEventListener("message", (event) => {
    messages.push(String(event.data));
    for (const wake of waiting.splice(0)) wake();
  });
  const closed = new Promise<{ code: number }>((resolve) => ws.addEventListener("close", (event) => resolve({ code: event.code })));
  ws.accept();
  opened.push(ws);
  cursor.set(ws, 0);
  const next = async () => {
    const at = cursor.get(ws) ?? 0;
    while (messages.length <= at) await new Promise<void>((resolve) => waiting.push(resolve));
    cursor.set(ws, at + 1);
    return messages[at] as string;
  };
  return { ws, messages, closed, next };
}

const numbers = (message: string) => (JSON.parse(message) as { versions: AreaVersions }).versions;
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

beforeAll(signIn);

afterEach(() => {
  for (const ws of opened.splice(0)) {
    try {
      ws.close(1000);
    } catch {
      // Already closed by the server.
    }
  }
  cursor = new WeakMap();
});

describe("opening the live channel", () => {
  it("opens with a live session and the site's Origin, and starts with the current numbers", async () => {
    const channel = await open();
    const first = numbers(await channel.next());
    expect(Object.keys(first).sort()).toEqual([...AREAS].sort());
    for (const n of Object.values(first)) expect(Number.isSafeInteger(n)).toBe(true);
  });

  it("is held with the Hibernation API, under its own tag", async () => {
    await open();
    expect(await inOwner((_agent, state) => state.getWebSockets(LIVE_TAG).length)).toBeGreaterThan(0);
  });

  it("refuses a page on another site (cross-site WebSocket hijacking) and a client with no Origin", async () => {
    for (const origin of ["https://atacante.exemplo.com.br", "null", ORIGIN.replace("https:", "http:"), `${ORIGIN}:8443`, null]) {
      const res = await upgrade({ origin });
      expect(res.status, String(origin)).toBe(403);
      expect(res.webSocket).toBeNull();
      expect((await errorBody(res)).code).toBe("CSRF_FAILED");
    }
  });

  it("refuses without a session, with a forged cookie and with a cookie that opens nothing", async () => {
    for (const value of [null, "__Host-zuri_session=x", `__Host-zuri_session=${"A".repeat(43)}`]) {
      const res = await upgrade({ cookie: value });
      expect(res.status, String(value)).toBe(401);
      expect(res.webSocket).toBeNull();
      expect((await errorBody(res)).code).toBe("UNAUTHORIZED");
    }
  });

  it("is the only upgrade: other paths, a trailing slash and other methods stay refused at the Worker", async () => {
    for (const [path, method] of [
      ["/api/live/", "GET"],
      ["/api/live/x", "GET"],
      ["/api/LIVE", "GET"],
      ["/api/health", "GET"],
      ["/api/live", "POST"],
    ] as const) {
      const res = await upgrade({}, { path, method });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.webSocket).toBeNull();
      expect((await errorBody(res)).code).toBe("FORBIDDEN");
    }
  });

  it("refuses an upgrade on any other path even when it reaches the object without the Worker", async () => {
    const res = await inOwner((agent) =>
      agent.fetch(new Request(`${ORIGIN}/api/tasks`, { headers: { upgrade: "websocket", origin: ORIGIN, cookie } })),
    );
    expect(res.status).toBe(403);
    expect(res.webSocket).toBeNull();
  });

  it("without the upgrade, the path is just an unknown route", async () => {
    const res = await api("GET", "/live");
    expect(res.status).toBe(404);
  });

  it(`keeps at most ${LIVE_LIMITS.maxSockets} channels: a new one closes the oldest`, async () => {
    const channels: Channel[] = [];
    for (let i = 0; i < LIVE_LIMITS.maxSockets; i++) channels.push(await open());
    const before = await inOwner((_agent, state) => state.getWebSockets(LIVE_TAG).length);
    expect(before).toBeLessThanOrEqual(LIVE_LIMITS.maxSockets);
    await open();
    expect((await channels[0]?.closed)?.code).toBe(LIVE_CLOSE.replaced);
    expect(await inOwner((_agent, state) => state.getWebSockets(LIVE_TAG).filter((ws) => ws.readyState === WebSocket.OPEN).length)).toBeLessThanOrEqual(
      LIVE_LIMITS.maxSockets,
    );
  });
});

describe("what the channel says", () => {
  it("writes the numbers when the owner changes something in the app", async () => {
    const channel = await open();
    const before = numbers(await channel.next());
    const res = await api("POST", "/tasks", { title: "Comprar ração" });
    expect(res.status).toBe(201);
    const after = numbers(await channel.next());
    expect(after.tasks).toBeGreaterThan(before.tasks ?? 0);
  });

  it("writes them for a change made outside any request (a routine, the bot, another device)", async () => {
    const channel = await open();
    const before = numbers(await channel.next());
    await inOwner((agent) => agent.store.db.run(`UPDATE zur_area_versions SET notes = notes + 1 WHERE id = 1`));
    const after = numbers(await channel.next());
    expect(after.notes).toBe((before.notes ?? 0) + 1);
  });

  it("says nothing while nothing moved: the heartbeat's own write sends no message", async () => {
    const channel = await open();
    await channel.next();
    expect((await api("POST", "/auth/heartbeat", { active: true })).status).toBe(200);
    await settle();
    expect(channel.messages).toHaveLength(1);
  });

  it("sends a burst of changes as few messages, never one per row", async () => {
    const channel = await open();
    await channel.next();
    await inOwner((agent) => {
      for (let i = 0; i < 20; i++) agent.store.db.run(`UPDATE zur_area_versions SET tasks = tasks + 1 WHERE id = 1`);
    });
    await channel.next();
    await settle();
    expect(channel.messages.length).toBe(2);
  });

  it("carries only numbers, never content", async () => {
    const channel = await open();
    await channel.next();
    await api("POST", "/tasks", { title: "Segredo do dono" });
    const message = await channel.next();
    expect(message).not.toContain("Segredo");
    expect(Object.keys(JSON.parse(message) as object)).toEqual(["versions"]);
    for (const n of Object.values(numbers(message))) expect(typeof n).toBe("number");
  });
});

describe("what the channel accepts from the browser", () => {
  it("answers the ping without the object reading it", async () => {
    const channel = await open();
    await channel.next();
    channel.ws.send("ping");
    expect(await channel.next()).toBe("pong");
  });

  it("closes on anything other than the ping (no commands, no state, no SDK protocol)", async () => {
    for (const payload of ["{\"type\":\"cf_agent_state\",\"state\":{}}", "x".repeat(4096), "PING", new Uint8Array([1, 2, 3])]) {
      const channel = await open();
      await channel.next();
      channel.ws.send(payload);
      expect((await channel.closed).code).toBe(LIVE_CLOSE.policy);
    }
  });
});

describe("when the session or the gates change", () => {
  it("closes when the session signs out", async () => {
    const channel = await open();
    await channel.next();
    expect((await api("POST", "/auth/logout")).status).toBeLessThan(300);
    expect((await channel.closed).code).toBe(LIVE_CLOSE.ended);
    const again = await upgrade();
    expect(again.status).toBe(401);
    await signIn();
  });

  it("closes when the session ends from another place (/sessoes, Encerrar) before anything is sent", async () => {
    const channel = await open();
    await channel.next();
    await inOwner((agent) => agent.store.auth.endSessions(null));
    expect((await channel.closed).code).toBe(LIVE_CLOSE.ended);
    expect(channel.messages).toHaveLength(1);
    await signIn();
  });

  it("closes in a lockdown (/bloquear) and refuses to open again until it ends", async () => {
    const channel = await open();
    await channel.next();
    await inOwner((agent) => agent.store.auth.enterLockdown("link-live"));
    const { code } = await channel.closed;
    // The lockdown ends every session in the same transaction: either reason closes it, nothing more is sent.
    expect([LIVE_CLOSE.closed, LIVE_CLOSE.ended]).toContain(code);
    expect(channel.messages).toHaveLength(1);
    await inOwner((agent) => agent.store.auth.lockdown.clear());
    await signIn();
    // Signed in again during a new lockdown: the session is valid, the channel still refused.
    await inOwner((agent) => {
      agent.store.auth.lockdown.mark("link-live-2");
    });
    const refused = await upgrade();
    expect(refused.status).toBe(403);
    expect(refused.webSocket).toBeNull();
    await inOwner((agent) => agent.store.auth.lockdown.clear());
    const reopened = await open();
    expect(numbers(await reopened.next())).toBeTruthy();
  });
});
