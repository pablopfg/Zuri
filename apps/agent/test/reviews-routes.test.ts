import { AGENT_INSTANCE_NAME, type NoticePage, type ReviewItem, type ReviewPage, type ReviewsStatus } from "@zuri/shared";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import { MockAIProvider } from "../src/ai/mock.ts";
import { InternalState } from "../src/db/internal-state.ts";
import { type DevGoogle, devGoogle, googleNetwork } from "../src/google/dev-google.ts";
import { call, CSRF, errorBody, HUMAN_TOKEN, ORIGIN, TEST_EMAIL, TEST_PASSWORD, testEnv } from "./helpers.ts";
import { LOCATION, PATTERN } from "./reviews-world.ts";

// Step 19c: Settings › Integrations › Google › Reviews and the Reviews tab, through the Worker.

const IP = "192.0.2.193";
let cookie = "";
let google: DevGoogle;
const owner = () => testEnv.AGENT.get(testEnv.AGENT.idFromName(AGENT_INSTANCE_NAME));
const inOwner = <T>(fn: (agent: ZuriAgent) => T | Promise<T>) => runInDurableObject(owner(), (agent: ZuriAgent) => fn(agent));

const headers = (withCookie = true) => ({ ...CSRF, "content-type": "application/json", "cf-connecting-ip": IP, ...(withCookie ? { cookie } : {}) });
const api = (method: string, path: string, body?: unknown, withCookie = true) =>
  call(`${ORIGIN}/api${path}`, { method, headers: headers(withCookie), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const stale = () => inOwner((agent) => agent.store.db.run(`UPDATE zur_sessions SET confirmed_at = ?`, Date.now() - 16 * 60_000));
const fresh = () => inOwner((agent) => agent.store.db.run(`UPDATE zur_sessions SET confirmed_at = ?`, Date.now()));
const SETTINGS = { locations: [LOCATION], ...PATTERN, level: "approve" };

async function consent(path: string): Promise<Response> {
  const begin = await api("POST", path);
  expect(begin.status).toBe(200);
  const { url } = (await begin.json()) as { url: string };
  const params = new URL(url).searchParams;
  return api("POST", "/google/callback", { state: params.get("state") ?? "", code: `dev.${params.get("code_challenge") ?? ""}` });
}

/** The calendar, then the reviews through Google's page, the profile picked and a first check. */
async function turnOn(): Promise<ReviewsStatus> {
  expect((await consent("/google/connect")).status).toBe(200);
  const res = await consent("/reviews/connect");
  expect(res.status).toBe(200);
  expect(((await res.json()) as { purpose: string }).purpose).toBe("reviews");
  expect((await api("GET", "/reviews/locations")).status).toBe(200);
  const saved = await api("PATCH", "/reviews/settings", SETTINGS);
  expect(saved.status).toBe(200);
  await inOwner((agent) => agent.store.db.run(`UPDATE zur_review_settings SET checked_now_at = NULL`));
  const checked = await api("POST", "/reviews/check");
  expect(checked.status).toBe(200);
  return (await checked.json()) as ReviewsStatus;
}

/** A new review at Google and a check that finds it. */
async function arrive(id: string, rating: number, comment?: string): Promise<ReviewItem> {
  google.business.add(LOCATION, { id, rating, name: "Ana Souza", ...(comment ? { comment } : {}) });
  await inOwner((agent) => agent.store.db.run(`UPDATE zur_review_settings SET checked_now_at = NULL`));
  expect((await api("POST", "/reviews/check")).status).toBe(200);
  const page = (await (await api("GET", "/reviews?tab=all")).json()) as ReviewPage;
  const found = page.items.find((item) => item.rating === rating && item.state !== "history");
  expect(found).toBeTruthy();
  return found as ReviewItem;
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
  google.business.accounts.push({ name: "accounts/101", accountName: "Exemplo" });
  google.business.locations.set("accounts/101", [{ name: "locations/201", title: "Exemplo Centro" }]);
  await inOwner((agent) => {
    agent.store.google.network = googleNetwork(google, { fetch: () => Promise.reject(new Error("no network in tests")) });
    // The simulated model: its answer isn't a draft, so the reply falls back to a template.
    agent.testProvider = new MockAIProvider();
  });
  await fresh();
});

afterEach(async () => {
  await inOwner(async (agent) => {
    const { db } = agent.store;
    const state = new InternalState(db);
    state.delete("lockdown_until");
    state.delete("google_oauth_pending");
    agent.store.reviews.disable();
    agent.testProvider = null;
    for (const table of ["zur_google_calendars", "zur_google_account", "zur_auth_events", "zur_notices"]) db.run(`DELETE FROM ${table}`);
  });
});

describe("/api/reviews", () => {
  it("needs a session and the CSRF header", async () => {
    expect((await api("GET", "/reviews/status", undefined, false)).status).toBe(401);
    expect((await call(`${ORIGIN}/api/reviews/status`, { headers: { cookie, "cf-connecting-ip": IP } })).status).toBe(403);
    expect((await api("GET", "/reviews", undefined, false)).status).toBe(401);
  });

  it("starts off, and can't be joined before the calendar is connected", async () => {
    const status = (await (await api("GET", "/reviews/status")).json()) as ReviewsStatus;
    expect(status).toMatchObject({ enabled: false, granted: false, problem: null, needs: 0, locations: [] });
    expect((await errorBody(await api("POST", "/reviews/connect"))).code).toBe("CONFLICT");
    expect((await errorBody(await api("POST", "/reviews/check"))).code).toBe("CONFLICT");
    expect(((await (await api("GET", "/reviews")).json()) as ReviewPage).items).toEqual([]);
  });

  it("asks for the password typed recently to join, to save the settings and to turn off", async () => {
    expect((await consent("/google/connect")).status).toBe(200);
    await stale();
    expect((await errorBody(await api("POST", "/reviews/connect"))).code).toBe("RECENT_AUTH_REQUIRED");
    await fresh();
    await turnOn();
    await stale();
    expect((await errorBody(await api("PATCH", "/reviews/settings", SETTINGS))).code).toBe("RECENT_AUTH_REQUIRED");
    expect((await errorBody(await api("DELETE", "/reviews"))).code).toBe("RECENT_AUTH_REQUIRED");
    // Pausing doesn't: it only holds things back.
    expect(((await (await api("POST", "/reviews/pause")).json()) as ReviewsStatus).paused).toBe(true);
    expect(((await (await api("POST", "/reviews/resume")).json()) as ReviewsStatus).paused).toBe(false);
  });

  it("refuses malformed input", async () => {
    await turnOn();
    for (const body of [
      {},
      { ...SETTINGS, locations: ["x"] },
      { ...SETTINGS, locations: [LOCATION, LOCATION, LOCATION, LOCATION] },
      { ...SETTINGS, templates: PATTERN.templates.slice(0, 2) },
      { ...SETTINGS, signature: "x" },
      { ...SETTINGS, level: "sozinha" },
      { ...SETTINGS, tone: "rude" },
      { ...SETTINGS, extra: 1 },
    ]) {
      expect((await api("PATCH", "/reviews/settings", body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await api("GET", "/reviews?tab=x")).status).toBe(400);
    expect((await api("GET", "/reviews?rating=6")).status).toBe(400);
    expect((await api("GET", "/reviews?cursor=x")).status).toBe(400);
    expect((await api("POST", "/reviews/not-an-id/resolve")).status).toBe(404);
    const item = await arrive("n1", 1, "Ruim");
    for (const body of [{}, { text: "x".repeat(4097), version: item.version }, { text: "Obrigado", version: "x" }]) {
      expect((await api("POST", `/reviews/${item.id}/approve`, body)).status).toBe(400);
    }
  });

  it("tells the team of a negative review with the name only in the body, and lists it under 'needs you'", async () => {
    await turnOn();
    const item = await arrive("n1", 2, "Demorou demais");
    expect(item).toMatchObject({ state: "escalated", firstName: "Ana", location: "Exemplo Centro" });
    const page = (await (await api("GET", "/reviews?tab=needs")).json()) as ReviewPage;
    expect(page.counts.needs).toBe(1);
    const notices = (await (await api("GET", "/notices")).json()) as NoticePage;
    const notice = notices.notices.find((n) => n.kind === "reviews.negative");
    expect(notice?.title).not.toContain("Ana");
    expect(notice?.body).toContain("Ana");
    expect(notice?.link).toBe("/contatos/avaliacoes");
    // Answers never carry Google's ids.
    expect(JSON.stringify(page)).not.toContain("accounts/");
  });

  it("publishes an approved reply, and deletes only Zuri's own", async () => {
    await turnOn();
    const item = await arrive("p1", 5);
    expect(item).toMatchObject({ state: "proposed", draftSource: "template" });
    const res = await api("POST", `/reviews/${item.id}/approve`, { text: item.draft, version: item.version });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { review: ReviewItem }).review).toMatchObject({ state: "replied", replyMine: true });
    expect(google.business.reviews.get(LOCATION)?.[0]?.reviewReply?.comment).toBe(item.draft);
    const gone = await api("DELETE", `/reviews/${item.id}/reply`);
    expect(((await gone.json()) as { review: ReviewItem }).review.state).toBe("new");
  });

  it("refuses an approval the checker fails, and one of an old version", async () => {
    await turnOn();
    const item = await arrive("p1", 5);
    const bad = await errorBody(await api("POST", `/reviews/${item.id}/approve`, { text: "Ganhe desconto!", version: item.version }));
    expect(bad).toMatchObject({ code: "VALIDATION_FAILED", details: { codes: expect.arrayContaining(["banned", "signature"]) } });
    const old = await errorBody(await api("POST", `/reviews/${item.id}/approve`, { text: item.draft, version: "0".repeat(64) }));
    expect(old.code).toBe("TARGET_CHANGED");
    expect(google.business.reviews.get(LOCATION)?.[0]?.reviewReply).toBeUndefined();
  });

  it("refuses to publish in a lockdown", async () => {
    await turnOn();
    const item = await arrive("p1", 5);
    await inOwner((agent) => new InternalState(agent.store.db).set("lockdown_until", new Date(Date.now() + 3_600_000).toISOString()));
    const res = await api("POST", `/reviews/${item.id}/approve`, { text: item.draft, version: item.version });
    expect(res.status).toBe(423);
  });

  it("discards, resolves and writes again", async () => {
    await turnOn();
    const item = await arrive("p1", 5);
    expect(((await (await api("POST", `/reviews/${item.id}/discard`)).json()) as { review: ReviewItem }).review).toMatchObject({ state: "new", draft: null });
    expect(((await (await api("POST", `/reviews/${item.id}/draft`)).json()) as { review: ReviewItem }).review).toMatchObject({ state: "proposed" });
    expect(((await (await api("POST", `/reviews/${item.id}/resolve`)).json()) as { review: ReviewItem }).review.state).toBe("resolved");
    expect((await api("POST", `/reviews/${item.id}/resolve`)).status).toBe(409);
  });

  it("limits 'check now' and says when a check is running", async () => {
    await turnOn();
    const soon = await api("POST", "/reviews/check");
    expect(soon.status).toBe(429);
    await inOwner((agent) => agent.store.db.run(`UPDATE zur_review_settings SET checked_now_at = NULL, running_since = ?`, Date.now()));
    expect((await errorBody(await api("POST", "/reviews/check"))).code).toBe("CONFLICT");
  });

  it("explains a missing API access in the status", async () => {
    await turnOn();
    google.business.failure = { status: 403, body: { error: { code: 403, status: "PERMISSION_DENIED" } } };
    await inOwner((agent) => agent.store.db.run(`UPDATE zur_review_settings SET checked_now_at = NULL`));
    const res = await api("POST", "/reviews/check");
    expect(res.status).toBe(200);
    expect((await res.json()) as ReviewsStatus).toMatchObject({ problem: "no_access", outcome: "failed" });
  });

  it("unlocks publishing by itself only after the trial, with the password typed recently and a security alert (step 19d)", async () => {
    // The access events' ids start over between tests (afterEach empties the table): their alert keys must too.
    await inOwner((agent) => agent.store.db.run(`DELETE FROM zur_alert_keys WHERE key LIKE 'auth-event:%'`));
    await turnOn();
    const auto = { ...SETTINGS, level: "auto" };
    expect((await errorBody(await api("PATCH", "/reviews/settings", auto))).code).toBe("CONFLICT");
    await inOwner((agent) => agent.store.db.run(`UPDATE zur_review_settings SET trial = '1111111111'`));
    expect(((await (await api("GET", "/reviews/status")).json()) as ReviewsStatus).trial).toEqual({ approved: 10, needed: 10 });
    await stale();
    expect((await errorBody(await api("PATCH", "/reviews/settings", auto))).code).toBe("RECENT_AUTH_REQUIRED");
    // A remote token (step 20) or anything without the owner's session never reaches it.
    const bearer = await call(`${ORIGIN}/api/reviews/settings`, { method: "PATCH", headers: { ...headers(false), authorization: "Bearer zur_pat_0000000000000000" }, body: JSON.stringify(auto) });
    expect(bearer.status).toBe(401);
    await fresh();
    const saved = await api("PATCH", "/reviews/settings", auto);
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as ReviewsStatus).level).toBe("auto");
    const alerts = () => inOwner((agent) => agent.store.db.all<{ kind: string; alert_pending: number }>(`SELECT kind, alert_pending FROM zur_auth_events WHERE kind = 'reviews_autonomy'`));
    expect(await alerts()).toHaveLength(1);
    const security = await inOwner((agent) => agent.store.db.all<{ params: string; priority: string }>(`SELECT params, priority FROM zur_notices WHERE kind = 'security'`));
    expect(security.map((n) => [JSON.parse(n.params).event, n.priority])).toContainEqual(["reviews_autonomy", "critical"]);
    // Saving again at the same level tells nothing new; going back to drafts neither.
    expect((await api("PATCH", "/reviews/settings", auto)).status).toBe(200);
    expect((await api("PATCH", "/reviews/settings", SETTINGS)).status).toBe(200);
    expect(await alerts()).toHaveLength(1);
    await inOwner((agent) => agent.store.db.run(`UPDATE zur_review_settings SET trial = ''`));
  });

  it("turning off forgets the copy and its notices; disconnecting Google forgets it too", async () => {
    await turnOn();
    await arrive("n1", 1, "Ruim");
    const off = (await (await api("DELETE", "/reviews")).json()) as ReviewsStatus;
    expect(off).toMatchObject({ enabled: false, needs: 0 });
    expect(await inOwner((agent) => agent.store.db.one(`SELECT count(*) AS n FROM zur_reviews`))).toEqual({ n: 0 });
    const notices = (await (await api("GET", "/notices")).json()) as NoticePage;
    expect(notices.notices.filter((n) => n.kind.startsWith("reviews."))).toEqual([]);
    expect(await inOwner((agent) => agent.store.google.connected())).toBe(true);
    await turnOn();
    await arrive("n2", 1, "Ruim");
    expect((await api("DELETE", "/google")).status).toBe(200);
    expect(await inOwner((agent) => agent.store.db.one(`SELECT count(*) AS n FROM zur_reviews`))).toEqual({ n: 0 });
  });
});
