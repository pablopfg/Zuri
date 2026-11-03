import { AGENT_INSTANCE_NAME, type ContactDetail, type ContactPage, type ContactsStatus, type NoticePage } from "@zuri/shared";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import { InternalState } from "../src/db/internal-state.ts";
import { type DevGoogle, devGoogle, googleNetwork } from "../src/google/dev-google.ts";
import { call, CSRF, errorBody, HUMAN_TOKEN, ORIGIN, TEST_EMAIL, TEST_PASSWORD, testEnv } from "./helpers.ts";

// Step 19b: Settings › Integrations › Google › Contacts and the Contacts screen, through the Worker.

const IP = "192.0.2.191";
let cookie = "";
let google: DevGoogle;
const owner = () => testEnv.AGENT.get(testEnv.AGENT.idFromName(AGENT_INSTANCE_NAME));
const inOwner = <T>(fn: (agent: ZuriAgent) => T | Promise<T>) => runInDurableObject(owner(), (agent: ZuriAgent) => fn(agent));

const headers = (withCookie = true) => ({ ...CSRF, "content-type": "application/json", "cf-connecting-ip": IP, ...(withCookie ? { cookie } : {}) });
const api = (method: string, path: string, body?: unknown, withCookie = true) =>
  call(`${ORIGIN}/api${path}`, { method, headers: headers(withCookie), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const stale = () => inOwner((agent) => agent.store.db.run(`UPDATE zur_sessions SET confirmed_at = ?`, Date.now() - 16 * 60_000));
const fresh = () => inOwner((agent) => agent.store.db.run(`UPDATE zur_sessions SET confirmed_at = ?`, Date.now()));

const CLIENTS = "contactGroups/clientes";
const FAMILY = "contactGroups/familia";

async function consent(path: string): Promise<Response> {
  const begin = await api("POST", path);
  expect(begin.status).toBe(200);
  const { url } = (await begin.json()) as { url: string };
  const params = new URL(url).searchParams;
  return api("POST", "/google/callback", { state: params.get("state") ?? "", code: `dev.${params.get("code_challenge") ?? ""}` });
}

/** The calendar, then the contacts through Google's page, then a first sync. */
async function turnOn(): Promise<ContactsStatus> {
  expect((await consent("/google/connect")).status).toBe(200);
  const res = await consent("/google/contacts/connect");
  expect(res.status).toBe(200);
  expect(((await res.json()) as { purpose: string }).purpose).toBe("contacts");
  const synced = await api("POST", "/google/contacts/sync");
  expect(synced.status).toBe(200);
  return (await synced.json()) as ContactsStatus;
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
  google.people.groups.push(
    { resourceName: CLIENTS, name: "Clientes", groupType: "USER_CONTACT_GROUP", memberCount: 1 },
    { resourceName: FAMILY, name: "Família", groupType: "USER_CONTACT_GROUP", memberCount: 1 },
  );
  const member = (label: string) => [{ contactGroupMembership: { contactGroupResourceName: label } }];
  google.people.add({ resourceName: "people/c1", names: [{ displayName: "Ana Souza" }], phoneNumbers: [{ value: "(11) 99999-0001" }], memberships: member(CLIENTS) });
  google.people.add({ resourceName: "people/c2", names: [{ displayName: "Bruno" }], memberships: member(FAMILY) });
  await inOwner((agent) => {
    agent.store.google.network = googleNetwork(google, { fetch: () => Promise.reject(new Error("no network in tests")) });
  });
  await fresh();
});

afterEach(async () => {
  await inOwner(async (agent) => {
    const { db } = agent.store;
    const state = new InternalState(db);
    state.delete("lockdown_until");
    state.delete("google_oauth_pending");
    agent.store.contacts.disable();
    for (const table of ["zur_google_calendars", "zur_google_account", "zur_auth_events", "zur_notices"]) db.run(`DELETE FROM ${table}`);
  });
});

describe("/api/google/contacts", () => {
  it("needs a session and the CSRF header", async () => {
    expect((await api("GET", "/google/contacts", undefined, false)).status).toBe(401);
    expect((await call(`${ORIGIN}/api/google/contacts`, { headers: { cookie, "cf-connecting-ip": IP } })).status).toBe(403);
    expect((await api("GET", "/contacts", undefined, false)).status).toBe(401);
  });

  it("starts off, and can't be turned on before the calendar is connected", async () => {
    const status = (await (await api("GET", "/google/contacts")).json()) as ContactsStatus;
    expect(status).toMatchObject({ connected: false, enabled: false, status: "off", problem: null, contacts: 0, labels: [] });
    const res = await api("POST", "/google/contacts/connect");
    expect(res.status).toBe(409);
    expect((await errorBody(res)).code).toBe("CONFLICT");
  });

  it("asks for the password typed recently to turn the contacts on, to add a label and to turn them off", async () => {
    expect((await consent("/google/connect")).status).toBe(200);
    await stale();
    expect((await errorBody(await api("POST", "/google/contacts/connect"))).code).toBe("RECENT_AUTH_REQUIRED");
    await fresh();
    await turnOn();
    await stale();
    expect((await errorBody(await api("PATCH", "/google/contacts/labels", { selected: [CLIENTS] }))).code).toBe("RECENT_AUTH_REQUIRED");
    expect((await errorBody(await api("DELETE", "/google/contacts"))).code).toBe("RECENT_AUTH_REQUIRED");
    // Removing labels and syncing don't.
    expect((await api("PATCH", "/google/contacts/labels", { selected: [] })).status).toBe(200);
    expect((await api("POST", "/google/contacts/sync")).status).toBe(200);
  });

  it("turns on through Google's page, copies the chosen labels and searches the copy", async () => {
    const first = await turnOn();
    expect(first).toMatchObject({ enabled: true, status: "ok", contacts: 0 });
    expect(first.labels.map((label) => label.name)).toEqual(["Clientes", "Família"]);
    const chosen = await api("PATCH", "/google/contacts/labels", { selected: [CLIENTS, CLIENTS] });
    expect(chosen.status).toBe(200);
    expect(((await chosen.json()) as ContactsStatus).labels.filter((label) => label.selected).map((label) => label.id)).toEqual([CLIENTS]);
    expect(((await (await api("POST", "/google/contacts/sync")).json()) as ContactsStatus).contacts).toBe(1);
    const page = (await (await api("GET", "/contacts?q=99999")).json()) as ContactPage;
    expect(page.contacts.map((contact) => contact.name)).toEqual(["Ana Souza"]);
    const one = await api("GET", `/contacts/${page.contacts[0]?.id ?? ""}`);
    expect(((await one.json()) as { contact: ContactDetail }).contact).toMatchObject({ name: "Ana Souza", labels: ["Clientes"], googleUrl: "https://contacts.google.com/person/c1" });
    expect((await api("GET", "/contacts/00000000-0000-4000-8000-000000000000")).status).toBe(404);
    // The owner's grant at Google now holds the contacts too, and the event is on record.
    const events = await inOwner((agent) => agent.store.db.all<{ kind: string }>(`SELECT kind FROM zur_auth_events WHERE kind = 'google_connected'`));
    expect(events).toHaveLength(2);
  });

  it("refuses malformed input", async () => {
    await turnOn();
    for (const body of [{ selected: ["people/c1"] }, { selected: "x" }, { selected: [], other: 1 }]) expect((await api("PATCH", "/google/contacts/labels", body)).status).toBe(400);
    for (const body of [{}, { time: "24:00" }, { daysAhead: 31 }, { daysAhead: -1 }, { match: "a‮b" }, { match: "x".repeat(61) }, { onAdded: "sms" }, { extra: true }]) {
      expect((await api("PATCH", "/google/contacts/settings", body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await api("GET", `/contacts?q=${"a".repeat(101)}`)).status).toBe(400);
    expect((await api("GET", "/contacts?label=people/c1")).status).toBe(400);
    expect((await api("GET", "/contacts?after=x")).status).toBe(400);
    expect((await api("GET", "/contacts?unknown=1")).status).toBe(200);
  });

  it("saves the notices' choices and plans the next one", async () => {
    await turnOn();
    const res = await api("PATCH", "/google/contacts/settings", { birthdays: true, dates: true, time: "07:30", daysAhead: 30, match: " Retorno ", onAdded: "task" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as ContactsStatus).reminders).toEqual({ birthdays: true, dates: true, time: "07:30", daysAhead: 30, match: "Retorno" });
    const next = await inOwner((agent) => agent.store.db.one<{ next_reminder: number }>(`SELECT next_reminder FROM zur_contact_sync`));
    expect(next?.next_reminder).toBeGreaterThan(Date.now());
  });

  it("says when a sync is already running and when the contacts are off", async () => {
    await turnOn();
    await inOwner((agent) => agent.store.db.run(`UPDATE zur_contact_sync SET running_since = ?`, Date.now()));
    const busy = await api("POST", "/google/contacts/sync");
    expect(busy.status).toBe(409);
    await inOwner((agent) => agent.store.db.run(`UPDATE zur_contact_sync SET running_since = NULL`));
    expect((await api("DELETE", "/google/contacts")).status).toBe(200);
    for (const [method, path, body] of [
      ["POST", "/google/contacts/sync", undefined],
      ["PATCH", "/google/contacts/labels", { selected: [CLIENTS] }],
      ["PATCH", "/google/contacts/settings", { birthdays: false }],
    ] as const) {
      const res = await api(method, path, body);
      expect(res.status).toBe(409);
    }
    expect(((await (await api("GET", "/contacts")).json()) as ContactPage).contacts).toEqual([]);
  });

  it("turning off forgets the copy; disconnecting Google revokes the access and forgets it too", async () => {
    await turnOn();
    await api("PATCH", "/google/contacts/labels", { selected: [CLIENTS] });
    await api("POST", "/google/contacts/sync");
    const off = (await (await api("DELETE", "/google/contacts")).json()) as ContactsStatus;
    expect(off).toMatchObject({ enabled: false, contacts: 0, labels: [] });
    expect(await inOwner((agent) => agent.store.db.one(`SELECT count(*) AS n FROM zur_contacts`))).toEqual({ n: 0 });
    // The calendar goes on.
    expect(await inOwner((agent) => agent.store.google.connected())).toBe(true);
    await turnOn();
    await api("PATCH", "/google/contacts/labels", { selected: [CLIENTS] });
    await api("POST", "/google/contacts/sync");
    expect((await api("DELETE", "/google")).status).toBe(200);
    expect(google.revoked).toHaveLength(1);
    expect(await inOwner((agent) => agent.store.db.one(`SELECT count(*) AS n FROM zur_contacts`))).toEqual({ n: 0 });
  });

  it("SEC-A9-01 and SEC-A12-01: a contact's name stays out of a notice's title, and turning off takes the notices made from the copy", async () => {
    await turnOn();
    await inOwner((agent) => {
      agent.store.alerts.raise({ kind: "contacts.added", category: "reminders", priority: "normal", params: { name: "Ana Souza", label: "Clientes" }, link: "/contatos" });
      agent.store.alerts.raise({ kind: "contacts.birthdays", category: "reminders", priority: "normal", params: { names: "Ana Souza" }, link: "/contatos" });
      agent.store.alerts.raise({ kind: "google.reconnect", category: "system", priority: "normal", link: "/configuracoes/integracoes" });
    });
    const before = (await (await api("GET", "/notices")).json()) as NoticePage;
    const added = before.notices.find((notice) => notice.kind === "contacts.added");
    // The title is what a discreet Telegram notice or a locked phone shows; the name only in the body.
    expect(added?.title).toBe("Contato novo numa etiqueta");
    expect(added?.body).toContain("Ana Souza");
    expect((await api("DELETE", "/google/contacts")).status).toBe(200);
    const after = (await (await api("GET", "/notices")).json()) as NoticePage;
    expect(after.notices.map((notice) => notice.kind)).toEqual(["google.reconnect"]);
  });

  it("does nothing during a lockdown", async () => {
    await turnOn();
    await inOwner((agent) => new InternalState(agent.store.db).set("lockdown_until", new Date(Date.now() + 3_600_000).toISOString()));
    for (const [method, path] of [
      ["GET", "/google/contacts"],
      ["POST", "/google/contacts/sync"],
      ["GET", "/contacts"],
    ] as const) {
      expect((await api(method, path)).status).toBe(423);
    }
  });
});
