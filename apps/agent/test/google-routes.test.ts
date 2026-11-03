import { AGENT_INSTANCE_NAME, type AgendaPage, type AgendaEvent, type GoogleCalendarInfo, type GoogleStatus } from "@zuri/shared";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import { InternalState } from "../src/db/internal-state.ts";
import { googlePushToken } from "../src/gates/google-push.ts";
import { type DevGoogle, devGoogle, googleNetwork } from "../src/google/dev-google.ts";
import { call, CSRF, errorBody, HUMAN_TOKEN, ORIGIN, TEST_EMAIL, TEST_PASSWORD, testEnv } from "./helpers.ts";

// Step 19: the Google Calendar through the Worker, as Settings › Integrations and the Agenda screen call it.

const IP = "192.0.2.190";
let cookie = "";
let google: DevGoogle;
const owner = () => testEnv.AGENT.get(testEnv.AGENT.idFromName(AGENT_INSTANCE_NAME));
const inOwner = <T>(fn: (agent: ZuriAgent) => T | Promise<T>) => runInDurableObject(owner(), (agent: ZuriAgent) => fn(agent));

const headers = (withCookie = true) => ({ ...CSRF, "content-type": "application/json", "cf-connecting-ip": IP, ...(withCookie ? { cookie } : {}) });
const api = (method: string, path: string, body?: unknown, withCookie = true) =>
  call(`${ORIGIN}/api${path}`, { method, headers: headers(withCookie), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const stale = () => inOwner((agent) => agent.store.db.run(`UPDATE zur_sessions SET confirmed_at = ?`, Date.now() - 16 * 60_000));
const fresh = () => inOwner((agent) => agent.store.db.run(`UPDATE zur_sessions SET confirmed_at = ?`, Date.now()));

/** What Google's consent page hands back: a code bound to the PKCE challenge of the URL. */
function consent(url: string): { state: string; code: string } {
  const params = new URL(url).searchParams;
  return { state: params.get("state") ?? "", code: `dev.${params.get("code_challenge") ?? ""}` };
}

async function connect(): Promise<GoogleStatus> {
  const begin = await api("POST", "/google/connect");
  expect(begin.status).toBe(200);
  const { url } = (await begin.json()) as { url: string };
  const res = await api("POST", "/google/callback", consent(url));
  expect(res.status).toBe(200);
  return (await res.json()) as GoogleStatus;
}

const setMode = (id: string, mode: string) => api("PATCH", `/google/calendars/${encodeURIComponent(id)}`, { mode });
const PRIMARY = "dono@exemplo.com.br";
const WORK = "trabalho@exemplo.com.br";
const READER = "consultorio@exemplo.com.br";
const FREE_BUSY = "livre@exemplo.com.br";

/** Today and the next day, local dates in the default zone. */
function window(): { from: string; to: string } {
  const today = new Date().toISOString().slice(0, 10);
  const after = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  return { from: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), to: after > today ? after : today };
}

function seedEvent(calendarId: string, summary: string, hoursFromNow = 2): string {
  const start = new Date(Date.now() + hoursFromNow * 3_600_000);
  const id = `seed${google.events.size}${Math.floor(Math.random() * 1e6)}`;
  const list = google.events.get(calendarId) ?? [];
  list.push({ id, etag: '"seed"', summary, start: { dateTime: start.toISOString() }, end: { dateTime: new Date(start.getTime() + 3_600_000).toISOString() } });
  google.events.set(calendarId, list);
  return id;
}

beforeAll(async () => {
  const res = await call(`${ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: headers(false),
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD, turnstileToken: HUMAN_TOKEN }),
  });
  expect(res.status).toBe(200);
  cookie = res.headers.getSetCookie().find((c) => c.startsWith("__Host-zuri_session="))?.split(";")[0] ?? "";
});

beforeEach(async () => {
  google = devGoogle({ clientId: testEnv.GOOGLE_CLIENT_ID, clientSecret: testEnv.GOOGLE_CLIENT_SECRET });
  await inOwner((agent) => {
    agent.store.google.network = googleNetwork(google, { fetch: () => Promise.reject(new Error("no network in tests")) });
  });
  await fresh();
});

afterEach(async () => {
  await inOwner((agent) => {
    const { db } = agent.store;
    const state = new InternalState(db);
    state.delete("lockdown_until");
    state.delete("google_oauth_pending");
    for (const table of ["zur_google_calendars", "zur_google_account", "zur_auth_events", "zur_notices"]) db.run(`DELETE FROM ${table}`);
  });
});

describe("/api/google: connecting", () => {
  it("needs a session and the CSRF header", async () => {
    expect((await api("GET", "/google", undefined, false)).status).toBe(401);
    expect((await call(`${ORIGIN}/api/google`, { headers: { cookie, "cf-connecting-ip": IP } })).status).toBe(403);
  });

  it("starts configured and not connected", async () => {
    const status = (await (await api("GET", "/google")).json()) as GoogleStatus;
    expect(status).toEqual({ configured: true, connected: false, account: null, status: null, problem: null, connectedAt: null, calendars: [] });
  });

  it("asks for the password typed recently to connect", async () => {
    await stale();
    const res = await api("POST", "/google/connect");
    expect(res.status).toBe(403);
    expect((await errorBody(res)).code).toBe("RECENT_AUTH_REQUIRED");
  });

  it("sends the owner to Google with PKCE, offline access, the two scopes and the fixed redirect", async () => {
    const { url } = (await (await api("POST", "/google/connect")).json()) as { url: string };
    const target = new URL(url);
    expect(target.origin + target.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const p = target.searchParams;
    expect(p.get("client_id")).toBe(testEnv.GOOGLE_CLIENT_ID);
    expect(p.get("redirect_uri")).toBe(`${ORIGIN}/configuracoes/integracoes`);
    expect(p.get("scope")?.split(" ").sort()).toEqual(["https://www.googleapis.com/auth/calendar.calendarlist.readonly", "https://www.googleapis.com/auth/calendar.events"]);
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get("access_type")).toBe("offline");
    expect(p.get("include_granted_scopes")).toBe("true");
    expect(p.get("state")).toMatch(/^g\.[A-Za-z0-9_-]{43}$/);
    // Nothing secret travels in the address.
    expect(url).not.toContain(testEnv.GOOGLE_CLIENT_SECRET ?? "x");
  });

  it("connects: the calendars arrive hidden, the tokens are sealed and never answered, and the owner is told", async () => {
    const status = await connect();
    expect(status).toMatchObject({ connected: true, account: PRIMARY, status: "connected", problem: null });
    expect(status.calendars.map((c) => [c.id, c.mode, c.writable])).toEqual([
      [PRIMARY, "off", true],
      [READER, "off", false],
      [FREE_BUSY, "off", false],
      [WORK, "off", true],
    ]);
    const body = JSON.stringify(status);
    expect(body).not.toMatch(/1\/\/dev-|ya29\./);
    const row = await inOwner((agent) => agent.store.db.one<{ refresh_token: string; access_token: string }>(`SELECT refresh_token, access_token FROM zur_google_account`));
    expect(row?.refresh_token).toMatch(/^v1\./);
    expect(row?.access_token).toMatch(/^v1\./);
    for (const token of google.refreshTokens) expect(row?.refresh_token).not.toContain(token);
    // The secret went only in the token request's body.
    expect(google.seen.find((r) => r.url.endsWith("/token"))?.body).toContain("client_secret=");
    const kinds = await inOwner((agent) => agent.store.db.all<{ kind: string }>(`SELECT kind FROM zur_auth_events`).map((r) => r.kind));
    expect(kinds).toContain("google_connected");
  });

  it("refuses a state used twice, an unknown one and one from another session", async () => {
    const { url } = (await (await api("POST", "/google/connect")).json()) as { url: string };
    const answer = consent(url);
    expect((await api("POST", "/google/callback", answer)).status).toBe(200);
    const again = await api("POST", "/google/callback", answer);
    expect(again.status).toBe(400);
    expect((await errorBody(again)).code).toBe("VALIDATION_FAILED");
    expect((await api("POST", "/google/callback", { state: `g.${"A".repeat(43)}`, code: "dev.x" })).status).toBe(400);
    // Another session's sign-in: the state matches but the session doesn't.
    const other = await inOwner((agent) => agent.store.google.begin("outra-sessao"));
    expect((await api("POST", "/google/callback", consent(other))).status).toBe(400);
  });

  it("refuses a state past its 10 minutes", async () => {
    const { url } = (await (await api("POST", "/google/connect")).json()) as { url: string };
    await inOwner((agent) => {
      const state = new InternalState(agent.store.db);
      const pending = JSON.parse(state.get<string>("google_oauth_pending") ?? "{}") as { expires: number };
      state.set("google_oauth_pending", JSON.stringify({ ...pending, expires: Date.now() - 1 }));
    });
    expect((await api("POST", "/google/callback", consent(url))).status).toBe(400);
  });

  it("refuses malformed callbacks before anything else", async () => {
    for (const body of [{ state: "x" }, { state: `g.${"A".repeat(43)}`, extra: 1 }, { state: `${"A".repeat(45)}` }]) {
      expect((await api("POST", "/google/callback", body)).status).toBe(400);
    }
  });

  it("saves nothing and gives the grant back when a permission was left unticked", async () => {
    google.grant = ["https://www.googleapis.com/auth/calendar.events"];
    const { url } = (await (await api("POST", "/google/connect")).json()) as { url: string };
    const res = await api("POST", "/google/callback", consent(url));
    expect(res.status).toBe(400);
    expect((await errorBody(res)).message).toMatch(/duas permissões|both permissions/);
    expect(google.revoked).toHaveLength(1);
    expect(((await (await api("GET", "/google")).json()) as GoogleStatus).connected).toBe(false);
  });

  it("says the owner said no when Google answers with an error", async () => {
    const { url } = (await (await api("POST", "/google/connect")).json()) as { url: string };
    const res = await api("POST", "/google/callback", { state: consent(url).state, error: "access_denied" });
    expect(res.status).toBe(400);
  });

  it("disconnects: forgets everything here and revokes at Google", async () => {
    await connect();
    const res = await api("DELETE", "/google");
    expect(res.status).toBe(200);
    expect(((await (await api("GET", "/google")).json()) as GoogleStatus).connected).toBe(false);
    expect(google.revoked).toHaveLength(1);
    expect(await inOwner((agent) => agent.store.db.one(`SELECT 1 FROM zur_google_calendars`))).toBeNull();
  });

  it("marks the connection and tells the owner once a day when Google revokes the access", async () => {
    await connect();
    await setMode(PRIMARY, "read");
    google.refreshTokens.clear();
    google.accessTokens.clear();
    const first = await api("GET", `/google/events?from=${window().from}&to=${window().to}`);
    expect(first.status).toBe(409);
    const status = (await (await api("GET", "/google")).json()) as GoogleStatus;
    expect(status).toMatchObject({ status: "error", problem: "revoked" });
    await api("GET", `/google/events?from=${window().from}&to=${window().to}`);
    const notices = await inOwner((agent) => agent.store.db.all(`SELECT 1 FROM zur_notices WHERE kind = 'google.reconnect'`));
    expect(notices).toHaveLength(1);
  });

  it("does nothing with Google during a lockdown", async () => {
    await connect();
    const before = google.seen.length;
    await inOwner((agent) => new InternalState(agent.store.db).set("lockdown_until", new Date(Date.now() + 3_600_000).toISOString()));
    const res = await api("POST", "/google/refresh");
    expect(res.status).toBe(423);
    await inOwner((agent) => new InternalState(agent.store.db).delete("lockdown_until"));
    expect(google.seen.length).toBe(before);
  });
});

describe("/api/google: calendars", () => {
  it("opens a calendar only with the password typed recently and hides one without it", async () => {
    await connect();
    await stale();
    expect((await setMode(PRIMARY, "read")).status).toBe(403);
    await fresh();
    expect((await setMode(PRIMARY, "read")).status).toBe(200);
    await stale();
    expect((await setMode(PRIMARY, "off")).status).toBe(200);
  });

  it("refuses writing where Google only lets read, and any mode for free/busy calendars", async () => {
    await connect();
    const reader = await setMode(READER, "write");
    expect(reader.status).toBe(400);
    expect((await setMode(READER, "read")).status).toBe(200);
    expect((await setMode(FREE_BUSY, "read")).status).toBe(400);
    expect((await setMode("nao-existe@exemplo.com.br", "read")).status).toBe(404);
    expect((await setMode(PRIMARY, "tudo")).status).toBe(400);
  });

  it("tells the owner when a calendar is opened for changes and opens its push channel", async () => {
    await connect();
    const res = await setMode(WORK, "write");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { calendar: GoogleCalendarInfo }).calendar).toMatchObject({ id: WORK, mode: "write" });
    const kinds = await inOwner((agent) => agent.store.db.all<{ kind: string }>(`SELECT kind FROM zur_auth_events`).map((r) => r.kind));
    expect(kinds).toContain("google_calendar_write");
    expect([...google.channels.values()].map((c) => [c.calendarId, c.address])).toEqual([[WORK, `${ORIGIN}/api/google/push`]]);
    // Hidden again: the channel is closed.
    await setMode(WORK, "off");
    expect(google.channels.size).toBe(0);
  });
});

describe("/api/google/events: the Agenda screen", () => {
  it("lists the open calendars' events in order and skips hidden calendars", async () => {
    await connect();
    await setMode(PRIMARY, "write");
    await setMode(READER, "read");
    seedEvent(PRIMARY, "Dentista", 3);
    seedEvent(READER, "Atendimento", 1);
    seedEvent(WORK, "Escondido", 2);
    const { from, to } = window();
    const page = (await (await api("GET", `/google/events?from=${from}&to=${to}`)).json()) as AgendaPage;
    expect(page.events.map((e) => e.title)).toEqual(["Atendimento", "Dentista"]);
    expect(page.calendars.map((c) => c.id).sort()).toEqual([PRIMARY, READER].sort());
  });

  it("refuses a window longer than six weeks, backwards or malformed", async () => {
    await connect();
    for (const q of ["from=2026-01-01&to=2026-03-01", "from=2026-02-01&to=2026-01-01", "from=amanha&to=2026-01-01", ""]) {
      expect((await api("GET", `/google/events?${q}`)).status).toBe(400);
    }
    expect((await api("GET", "/google/events?from=2026-01-01&to=2026-02-12")).status).toBe(200);
  });

  it("creates, changes and deletes an event, with nobody e-mailed and the version checked", async () => {
    await connect();
    await setMode(WORK, "write");
    const created = await api("POST", "/google/events", { calendarId: WORK, title: "Revisão", allDay: false, start: "2026-11-05T14:00", end: "2026-11-05T15:00" });
    expect(created.status).toBe(201);
    const { event } = (await created.json()) as { event: AgendaEvent };
    expect(event).toMatchObject({ title: "Revisão", allDay: false, start: "2026-11-05T17:00:00.000Z", end: "2026-11-05T18:00:00.000Z" });
    const insert = google.seen.find((r) => r.method === "POST" && r.url.includes("/events?"));
    expect(new URL(insert?.url ?? "x:").searchParams.get("sendUpdates")).toBe("none");
    expect(JSON.parse(insert?.body ?? "{}")).not.toHaveProperty("attendees");

    const moved = await api("PATCH", "/google/events", { calendarId: WORK, eventId: event.id, etag: event.etag, start: "2026-11-05T16:00" });
    expect(moved.status).toBe(200);
    const after = ((await moved.json()) as { event: AgendaEvent }).event;
    // Moving the start keeps the length.
    expect([after.start, after.end]).toEqual(["2026-11-05T19:00:00.000Z", "2026-11-05T20:00:00.000Z"]);
    expect(google.seen.filter((r) => r.method === "PATCH").at(-1)?.headers["if-match"]).toBe(event.etag);

    // The old version: refused, nothing changed.
    const stalePatch = await api("PATCH", "/google/events", { calendarId: WORK, eventId: event.id, etag: event.etag, title: "Outro" });
    expect(stalePatch.status).toBe(409);
    expect((await errorBody(stalePatch)).code).toBe("TARGET_CHANGED");
    const staleDelete = await api("DELETE", "/google/events", { calendarId: WORK, eventId: event.id, etag: event.etag });
    expect(staleDelete.status).toBe(409);

    expect((await api("DELETE", "/google/events", { calendarId: WORK, eventId: event.id, etag: after.etag })).status).toBe(200);
    expect(google.events.get(WORK)?.find((e) => e.id === event.id)).toBeUndefined();
  });

  it("creates an all-day event with an inclusive end", async () => {
    await connect();
    await setMode(PRIMARY, "write");
    const res = await api("POST", "/google/events", { calendarId: PRIMARY, title: "Viagem", allDay: true, start: "2026-12-20", end: "2026-12-22" });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { event: AgendaEvent }).event).toMatchObject({ allDay: true, start: "2026-12-20", end: "2026-12-23" });
  });

  it("refuses changes in read-only and hidden calendars, bad dates and oversized fields", async () => {
    await connect();
    await setMode(READER, "read");
    await setMode(PRIMARY, "write");
    const base = { title: "X", allDay: false, start: "2026-11-05T14:00", end: "2026-11-05T15:00" };
    expect((await api("POST", "/google/events", { ...base, calendarId: READER })).status).toBe(400);
    expect((await api("POST", "/google/events", { ...base, calendarId: WORK })).status).toBe(404);
    expect((await api("POST", "/google/events", { ...base, calendarId: PRIMARY, end: "2026-11-05T13:00" })).status).toBe(400);
    expect((await api("POST", "/google/events", { ...base, calendarId: PRIMARY, start: "2026-02-30T10:00", end: "2026-03-01T10:00" })).status).toBe(400);
    expect((await api("POST", "/google/events", { ...base, calendarId: PRIMARY, end: "2026-11-20T15:00" })).status).toBe(400);
    expect((await api("POST", "/google/events", { ...base, calendarId: PRIMARY, title: "x".repeat(201) })).status).toBe(400);
    expect((await api("POST", "/google/events", { ...base, calendarId: PRIMARY, title: "x".repeat(200) })).status).toBe(201);
    expect((await api("POST", "/google/events", { ...base, calendarId: PRIMARY, attendees: [{ email: "a@exemplo.com.br" }] })).status).toBe(400);
    expect((await api("POST", "/google/events", { ...base, calendarId: "a/../b" })).status).toBe(400);
  });

  it("cleans what Google sends: no control or bidi characters in titles", async () => {
    await connect();
    await setMode(PRIMARY, "read");
    seedEvent(PRIMARY, "Reuni‮ão\u0007 <script>");
    const page = (await (await api("GET", `/google/events?from=${window().from}&to=${window().to}`)).json()) as AgendaPage;
    expect(page.events[0]?.title).toBe("Reuni ão <script>");
  });
});

describe("/api/google/push: changes made elsewhere", () => {
  async function watched(): Promise<string> {
    await connect();
    await setMode(PRIMARY, "read");
    const [id] = [...google.channels.keys()];
    return id ?? "";
  }
  const version = () => inOwner((agent) => agent.store.db.one<{ calendar: number }>(`SELECT calendar FROM zur_area_versions WHERE id = 1`)?.calendar ?? 0);
  const push = (channel: string, token: string, state = "exists") =>
    call(`${ORIGIN}/api/google/push`, { method: "POST", headers: { "x-goog-channel-id": channel, "x-goog-channel-token": token, "x-goog-resource-state": state } });

  it("moves the calendar area for a notice with the channel's token", async () => {
    const channel = await watched();
    expect(google.channels.get(channel)?.token).toBe(await googlePushToken(testEnv.SESSION_SECRET, channel));
    const before = await version();
    const res = await push(channel, await googlePushToken(testEnv.SESSION_SECRET, channel));
    expect(res.status).toBe(200);
    expect(await version()).toBe(before + 1);
  });

  it("ignores the first sync notice, a wrong token, an unknown channel and a GET, always with an empty 200", async () => {
    const channel = await watched();
    const before = await version();
    const token = await googlePushToken(testEnv.SESSION_SECRET, channel);
    const other = crypto.randomUUID();
    for (const res of [
      await push(channel, token, "sync"),
      await push(channel, "0".repeat(64)),
      await push(other, await googlePushToken(testEnv.SESSION_SECRET, other)),
      await push("nao-e-uuid", token),
      await call(`${ORIGIN}/api/google/push`, { headers: { "x-goog-channel-id": channel, "x-goog-channel-token": token } }),
    ]) {
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("");
    }
    expect(await version()).toBe(before);
  });
});
