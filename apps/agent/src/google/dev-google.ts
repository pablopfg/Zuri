import { CONTACTS_SCOPE, GOOGLE_CALLBACK_PATH, toBase64Url } from "@zuri/shared";
import type { GoogleNetwork } from "./service.ts";

/**
 * A simulated Google (step 19) for local development, the e2e tests and the
 * unit tests: the token endpoint (PKCE, client and redirect checked), the
 * revocation, the calendar list and the events with etags, `If-Match` and push
 * channels, and the People API's contacts and labels with sync tokens (step
 * 19b). Nothing here reaches the internet. Google's consent page itself is
 * the browser's: in the e2e a route answers it with a redirect carrying the
 * code `dev.<PKCE challenge>`, which stands for the owner's approval.
 */

export interface DevCalendar {
  id: string;
  summary: string;
  accessRole: "owner" | "writer" | "reader" | "freeBusyReader";
  primary?: boolean;
  backgroundColor?: string;
  timeZone?: string;
}

export type DevTime = { date?: string; dateTime?: string; timeZone?: string };

export interface DevEvent {
  id: string;
  etag: string;
  status?: string;
  summary?: string;
  location?: string;
  description?: string;
  start: DevTime;
  end: DevTime;
  attendees?: unknown[];
  organizer?: { email?: string; self?: boolean };
  recurringEventId?: string;
}

/** A person as the People API sends it (step 19b); `version` orders the changes for the sync tokens. */
export interface DevPerson {
  resourceName: string;
  etag: string;
  [field: string]: unknown;
}

export interface DevGroup {
  resourceName: string;
  name: string;
  groupType: "USER_CONTACT_GROUP" | "SYSTEM_CONTACT_GROUP";
  memberCount?: number;
}

export interface DevPeople {
  persons: Map<string, { person: DevPerson; version: number; deleted: boolean }>;
  groups: DevGroup[];
  /** Every sync token handed out is refused as expired (more than 7 days old). */
  expired: boolean;
  /** Makes every People API call answer this status and body, or null. */
  failure: { status: number; body: unknown } | null;
  /** Answers in place of a page (a malformed one), or null. */
  raw: unknown | null;
  add(person: { resourceName: string; etag?: string; [field: string]: unknown }): DevPerson;
  update(resourceName: string, patch: Record<string, unknown>): void;
  remove(resourceName: string): void;
}

export interface DevGoogle {
  people: DevPeople;
  clientId: string;
  clientSecret: string;
  calendars: DevCalendar[];
  events: Map<string, DevEvent[]>;
  /** Scopes the consent page "granted"; fewer than asked shows the partial grant. */
  grant: string[] | null;
  /** Refresh tokens handed out and not revoked. */
  refreshTokens: Set<string>;
  accessTokens: Set<string>;
  revoked: string[];
  channels: Map<string, { calendarId: string; resourceId: string; token: string; address: string }>;
  /** Every request Google got, for the tests (bodies included: these are fake tokens). */
  seen: { url: string; method: string; body: string; headers: Record<string, string> }[];
  /** How long Google keeps a push channel (a week; a test makes it shorter). */
  watchTtlMs: number;
  /** Makes every call answer this status (a Google outage), or null. */
  outage: number | null;
  handle(request: Request): Promise<Response | null>;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const random = () => toBase64Url(crypto.getRandomValues(new Uint8Array(16)));

async function s256(verifier: string): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

const GOOGLE_HOSTS = new Set(["oauth2.googleapis.com", "www.googleapis.com", "people.googleapis.com"]);
// What the consent page grants by default: the calendar and, joined to it, the contacts (step 19b).
const SCOPES = ["https://www.googleapis.com/auth/calendar.calendarlist.readonly", "https://www.googleapis.com/auth/calendar.events", CONTACTS_SCOPE];

export function devGoogle(options: { clientId?: string | undefined; clientSecret?: string | undefined; calendars?: DevCalendar[]; clock?: () => number } = {}): DevGoogle {
  const clock = options.clock ?? Date.now;
  let version = 1;
  const nextEtag = () => `"${version++}"`;
  let changes = 1;
  const people: DevPeople = {
    persons: new Map(),
    groups: [],
    expired: false,
    failure: null,
    raw: null,
    add(person) {
      const version = changes++;
      const stored: DevPerson = { ...person, etag: person.etag ?? `%E${version}` };
      people.persons.set(person.resourceName, { person: stored, version, deleted: false });
      return stored;
    },
    update(resourceName, patch) {
      const entry = people.persons.get(resourceName);
      if (!entry) return;
      const version = changes++;
      entry.person = { ...entry.person, ...patch, resourceName, etag: `%E${version}` };
      entry.version = version;
    },
    remove(resourceName) {
      const entry = people.persons.get(resourceName);
      if (!entry) return;
      entry.deleted = true;
      entry.version = changes++;
    },
  };
  const google: DevGoogle = {
    people,
    clientId: options.clientId ?? "dev-client.apps.googleusercontent.com",
    clientSecret: options.clientSecret ?? "dev-secret",
    calendars: options.calendars ?? [
      { id: "dono@exemplo.com.br", summary: "dono@exemplo.com.br", accessRole: "owner", primary: true, backgroundColor: "#4f7cff", timeZone: "America/Sao_Paulo" },
      { id: "trabalho@exemplo.com.br", summary: "Trabalho", accessRole: "writer", backgroundColor: "#16a34a" },
      { id: "consultorio@exemplo.com.br", summary: "Consultório", accessRole: "reader", backgroundColor: "#f59e0b" },
      { id: "livre@exemplo.com.br", summary: "Livre e ocupado", accessRole: "freeBusyReader" },
    ],
    events: new Map(),
    grant: null,
    refreshTokens: new Set(),
    accessTokens: new Set(),
    revoked: [],
    channels: new Map(),
    seen: [],
    watchTtlMs: 7 * 86_400_000,
    outage: null,
    async handle(request) {
      const url = new URL(request.url);
      if (!GOOGLE_HOSTS.has(url.hostname)) return null;
      const body = request.method === "GET" || request.method === "DELETE" ? "" : new TextDecoder().decode(await request.arrayBuffer());
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headers[key] = value;
      });
      google.seen.push({ url: url.href, method: request.method, body, headers });
      if (google.outage) return json({ error: { code: google.outage } }, google.outage);
      if (url.hostname === "oauth2.googleapis.com") return token(url, body);
      const auth = request.headers.get("authorization") ?? "";
      if (!auth.startsWith("Bearer ") || !google.accessTokens.has(auth.slice(7))) return json({ error: { code: 401 } }, 401);
      if (url.hostname === "people.googleapis.com") return peopleApi(url, request.method);
      return api(url, request.method, body, request.headers);
    },
  };

  const codes = new Map<string, true>();

  async function token(url: URL, body: string): Promise<Response> {
    if (url.pathname === "/revoke") {
      const form = new URLSearchParams(body);
      const value = form.get("token") ?? "";
      google.revoked.push(value);
      google.refreshTokens.delete(value);
      return json({});
    }
    if (url.pathname !== "/token") return json({ error: "not_found" }, 404);
    const form = new URLSearchParams(body);
    if (form.get("client_id") !== google.clientId || form.get("client_secret") !== google.clientSecret) return json({ error: "invalid_client" }, 401);
    const issue = (refresh?: string) => {
      const access = `ya29.dev-${random()}`;
      google.accessTokens.add(access);
      return json({
        access_token: access,
        expires_in: 3599,
        token_type: "Bearer",
        scope: (google.grant ?? SCOPES).join(" "),
        ...(refresh ? { refresh_token: refresh } : {}),
      });
    };
    if (form.get("grant_type") === "authorization_code") {
      const code = form.get("code") ?? "";
      const verifier = form.get("code_verifier") ?? "";
      // One use per code, and only for the verifier whose challenge it carries.
      if (codes.has(code) || !code.startsWith("dev.") || code.slice(4) !== (await s256(verifier))) return json({ error: "invalid_grant" }, 400);
      if (!(form.get("redirect_uri") ?? "").endsWith(GOOGLE_CALLBACK_PATH)) return json({ error: "redirect_uri_mismatch" }, 400);
      codes.set(code, true);
      const refresh = `1//dev-${random()}`;
      google.refreshTokens.add(refresh);
      return issue(refresh);
    }
    if (form.get("grant_type") === "refresh_token") {
      if (!google.refreshTokens.has(form.get("refresh_token") ?? "")) return json({ error: "invalid_grant" }, 400);
      return issue();
    }
    return json({ error: "unsupported_grant_type" }, 400);
  }

  function calendarOf(id: string): DevCalendar | undefined {
    return google.calendars.find((calendar) => calendar.id === id);
  }

  function list(id: string): DevEvent[] {
    let events = google.events.get(id);
    if (!events) {
      events = [];
      google.events.set(id, events);
    }
    return events;
  }

  const startOf = (event: DevEvent) => Date.parse(event.start.dateTime ?? `${event.start.date ?? ""}T00:00:00Z`);
  const endOf = (event: DevEvent) => Date.parse(event.end.dateTime ?? `${event.end.date ?? ""}T00:00:00Z`);

  function api(url: URL, method: string, body: string, headers: Headers): Response {
    const path = url.pathname.replace(/^\/calendar\/v3/, "");
    if (method === "GET" && path === "/users/me/calendarList") return json({ items: google.calendars });
    if (method === "POST" && path === "/channels/stop") {
      const input = JSON.parse(body || "{}") as { id?: string };
      google.channels.delete(input.id ?? "");
      return new Response(null, { status: 204 });
    }
    const match = /^\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(path);
    if (!match) return json({ error: { code: 404 } }, 404);
    const calendarId = decodeURIComponent(match[1] ?? "");
    const calendar = calendarOf(calendarId);
    if (!calendar || calendar.accessRole === "freeBusyReader") return json({ error: { code: 404 } }, 404);
    const eventId = match[2] ? decodeURIComponent(match[2]) : null;
    const events = list(calendarId);
    const canWrite = calendar.accessRole === "owner" || calendar.accessRole === "writer";
    if (eventId === "watch" && method === "POST") {
      const input = JSON.parse(body || "{}") as { id: string; token: string; address: string };
      const resourceId = `res-${random()}`;
      google.channels.set(input.id, { calendarId, resourceId, token: input.token, address: input.address });
      return json({ kind: "api#channel", id: input.id, resourceId, expiration: String(clock() + google.watchTtlMs) });
    }
    if (!eventId) {
      if (method === "GET") {
        const from = Date.parse(url.searchParams.get("timeMin") ?? "");
        const to = Date.parse(url.searchParams.get("timeMax") ?? "");
        const q = (url.searchParams.get("q") ?? "").toLowerCase();
        const max = Number(url.searchParams.get("maxResults") ?? "250");
        const found = events
          .filter((event) => event.status !== "cancelled" && endOf(event) > from && startOf(event) < to)
          .filter((event) => !q || `${event.summary ?? ""} ${event.description ?? ""} ${event.location ?? ""}`.toLowerCase().includes(q))
          .sort((a, b) => startOf(a) - startOf(b));
        return json({ items: found.slice(0, max), ...(found.length > max ? { nextPageToken: "more" } : {}) });
      }
      if (method === "POST") {
        if (!canWrite) return json({ error: { code: 403 } }, 403);
        const input = JSON.parse(body || "{}") as Partial<DevEvent>;
        const event: DevEvent = { ...(input as DevEvent), id: `ev${random().replace(/[-_]/g, "").toLowerCase().slice(0, 12)}`, etag: nextEtag() };
        events.push(event);
        return json(event);
      }
      return json({ error: { code: 405 } }, 405);
    }
    const index = events.findIndex((event) => event.id === eventId);
    const event = index >= 0 ? events[index] : undefined;
    if (!event || event.status === "cancelled") return json({ error: { code: 404 } }, 404);
    if (method === "GET") return json(event);
    if (!canWrite) return json({ error: { code: 403 } }, 403);
    const ifMatch = headers.get("if-match");
    if (ifMatch && ifMatch !== event.etag) return json({ error: { code: 412 } }, 412);
    if (method === "PATCH") {
      const patch = JSON.parse(body || "{}") as Partial<DevEvent>;
      // As Google does: start and end merge field by field, and a null clears a field.
      const merge = (before: DevTime, change: unknown): DevTime => {
        const out: Record<string, unknown> = { ...before };
        for (const [key, value] of Object.entries((change ?? {}) as Record<string, unknown>)) {
          if (value === null) delete out[key];
          else out[key] = value;
        }
        return out as DevTime;
      };
      const updated: DevEvent = { ...event, ...patch, id: event.id, etag: nextEtag() };
      if (patch.start !== undefined) updated.start = merge(event.start, patch.start);
      if (patch.end !== undefined) updated.end = merge(event.end, patch.end);
      if ([updated.start, updated.end].some((time) => time?.date !== undefined && time.dateTime !== undefined)) return json({ error: { code: 400 } }, 400);
      events[index] = updated;
      return json(updated);
    }
    if (method === "DELETE") {
      events.splice(index, 1);
      return new Response(null, { status: 204 });
    }
    return json({ error: { code: 405 } }, 405);
  }

  /**
   * people.connections.list and contactGroups.list: pages by offset, sync
   * tokens by version ("sync.<n>": what changed after change n, deleted ones
   * included), the same fields on every page as Google requires.
   */
  function peopleApi(url: URL, method: string): Response {
    if (method !== "GET") return json({ error: { code: 405 } }, 405);
    if (people.failure) return json(people.failure.body, people.failure.status);
    if (google.grant && !google.grant.includes(CONTACTS_SCOPE)) {
      return json({ error: { code: 403, status: "PERMISSION_DENIED", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } }, 403);
    }
    if (url.pathname === "/v1/contactGroups") {
      return json({ contactGroups: people.groups.map((group) => ({ ...group, formattedName: group.name })), totalItems: people.groups.length });
    }
    if (url.pathname !== "/v1/people/me/connections") return json({ error: { code: 404 } }, 404);
    if (people.raw !== null) return json(people.raw);
    if (!url.searchParams.get("personFields")) return json({ error: { code: 400 } }, 400);
    const syncToken = url.searchParams.get("syncToken");
    let since = 0;
    if (syncToken !== null) {
      const match = /^sync\.(\d+)$/.exec(syncToken);
      if (!match || people.expired) {
        return json({ error: { code: 400, status: "FAILED_PRECONDITION", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "EXPIRED_SYNC_TOKEN" }] } }, 400);
      }
      since = Number(match[1]);
    }
    const all = [...people.persons.values()]
      .filter((entry) => (syncToken === null ? !entry.deleted : entry.version > since))
      .sort((a, b) => a.version - b.version);
    const size = Math.min(1000, Math.max(1, Number(url.searchParams.get("pageSize") ?? "100")));
    const offset = Number(/^p\.(\d+)$/.exec(url.searchParams.get("pageToken") ?? "")?.[1] ?? "0");
    const page = all.slice(offset, offset + size).map((entry) => (entry.deleted ? { resourceName: entry.person.resourceName, etag: entry.person.etag, metadata: { deleted: true } } : entry.person));
    const more = offset + size < all.length;
    const last = changes - 1;
    return json({
      connections: page,
      totalItems: all.length,
      ...(more ? { nextPageToken: `p.${offset + size}` } : {}),
      ...(!more && (syncToken !== null || url.searchParams.get("requestSyncToken") === "true") ? { nextSyncToken: `sync.${last}` } : {}),
    });
  }

  return google;
}

/** A network where Google is the simulation and anything else goes out as usual. */
export function googleNetwork(google: DevGoogle, real: GoogleNetwork = { fetch: (input, init) => fetch(input, init) }): GoogleNetwork {
  return {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      return (await google.handle(request)) ?? real.fetch(request);
    }) as typeof fetch,
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A few sample events around today, for `npm run dev`, the e2e and the screenshots. */
function seed(google: DevGoogle): void {
  // Today in America/Sao_Paulo (UTC-3), the sample owner's zone, so "today" is the owner's day at any hour.
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date()).split("-").map(Number) as [number, number, number];
  const day = (offset: number) => {
    const date = new Date(Date.UTC(y, m - 1, d + offset));
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  };
  const at = (offset: number, hour: number, minute = 0) => `${day(offset)}T${pad(hour)}:${pad(minute)}:00-03:00`;
  let n = 0;
  const add = (calendarId: string, summary: string, start: DevEvent["start"], end: DevEvent["end"], extra: Partial<DevEvent> = {}) => {
    const events = google.events.get(calendarId) ?? [];
    events.push({ id: `exemplo${n++}`, etag: `"seed${n}"`, summary, start, end, ...extra });
    google.events.set(calendarId, events);
  };
  add("dono@exemplo.com.br", "Café com a Ana", { dateTime: at(0, 9) }, { dateTime: at(0, 10) }, { location: "Padaria Central" });
  add("dono@exemplo.com.br", "Dentista", { dateTime: at(1, 15) }, { dateTime: at(1, 16) });
  add("dono@exemplo.com.br", "Aniversário da Bia", { date: day(3) }, { date: day(4) });
  add("trabalho@exemplo.com.br", "Reunião de planejamento", { dateTime: at(0, 14) }, { dateTime: at(0, 15, 30) }, { attendees: [{}, {}, {}] });
  add("trabalho@exemplo.com.br", "Revisão do projeto", { dateTime: at(2, 10) }, { dateTime: at(2, 11) });
  add("consultorio@exemplo.com.br", "Atendimento", { dateTime: at(0, 16) }, { dateTime: at(0, 17) });
  add("consultorio@exemplo.com.br", "Atendimento", { dateTime: at(1, 8) }, { dateTime: at(1, 9) });
  seedContacts(google, m, d);
}

/** Sample labels and contacts (step 19b): one birthday today, one special date next week, names with accents. */
function seedContacts(google: DevGoogle, month: number, day: number): void {
  google.people.groups.push(
    { resourceName: "contactGroups/clientes", name: "Clientes", groupType: "USER_CONTACT_GROUP", memberCount: 4 },
    { resourceName: "contactGroups/familia", name: "Família", groupType: "USER_CONTACT_GROUP", memberCount: 2 },
    { resourceName: "contactGroups/fornecedores", name: "Fornecedores", groupType: "USER_CONTACT_GROUP", memberCount: 1 },
    { resourceName: "contactGroups/myContacts", name: "myContacts", groupType: "SYSTEM_CONTACT_GROUP", memberCount: 7 },
  );
  const member = (...labels: string[]) => labels.map((label) => ({ contactGroupMembership: { contactGroupResourceName: `contactGroups/${label}` } }));
  const person = (id: string, name: string, extra: Record<string, unknown>, ...labels: string[]) =>
    google.people.add({ resourceName: `people/${id}`, names: [{ displayName: name }], memberships: member(...labels, "myContacts"), ...extra });
  person(
    "c1001",
    "Ana Souza",
    {
      phoneNumbers: [{ value: "(11) 99999-0001", canonicalForm: "+5511999990001", formattedType: "Celular" }],
      emailAddresses: [{ value: "ana@exemplo.com.br", formattedType: "Trabalho" }],
      birthdays: [{ date: { month, day } }],
      organizations: [{ name: "Padaria Central", title: "Gerente" }],
      biographies: [{ value: "Prefere contato por mensagem à tarde." }],
      userDefined: [{ key: "Plano", value: "Mensal" }],
    },
    "clientes",
  );
  person("c1002", "Bruno Lima", { phoneNumbers: [{ value: "(21) 98888-0002", canonicalForm: "+5521988880002" }], events: [{ date: { month: 12, day: 15 }, formattedType: "Retorno" }] }, "clientes");
  person("c1003", "Conceição Alves", { phoneNumbers: [{ value: "(31) 97777-0003" }], birthdays: [{ date: { year: 1980, month: 3, day: 9 } }] }, "familia");
  person("c1004", "Diego Martins", { emailAddresses: [{ value: "diego@exemplo.com.br" }] }, "clientes", "fornecedores");
  person("c1005", "Elisa Rocha", { phoneNumbers: [{ value: "+55 11 96666-0005" }], biographies: [{ value: "Cliente desde 2022." }] }, "clientes");
  person("c1006", "Fábio Nunes", { phoneNumbers: [{ value: "(41) 95555-0006" }] }, "familia");
  person("c1007", "Gabriela Teixeira", { emailAddresses: [{ value: "gabi@exemplo.com.br" }] });
}

let development: DevGoogle | null = null;

/** Local development's Google: one per isolate, seeded with sample events. Every call to Google is answered here. */
export function developmentGoogle(clientId: string | undefined, clientSecret: string | undefined): DevGoogle {
  if (!development) {
    development = devGoogle({ clientId: clientId?.trim() || undefined, clientSecret: clientSecret?.trim() || undefined });
    seed(development);
  }
  return development;
}

/** The development network: nothing addressed to Google leaves the machine. */
export function developmentGoogleNetwork(google: DevGoogle): GoogleNetwork {
  return {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      return (await google.handle(request)) ?? new Response(null, { status: 502 });
    }) as typeof fetch,
  };
}
