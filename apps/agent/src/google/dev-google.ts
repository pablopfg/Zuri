import { toBase64Url } from "@zuri/shared";
import type { GoogleNetwork } from "./service.ts";

/**
 * A simulated Google (step 19) for local development, the e2e tests and the
 * unit tests: the token endpoint (PKCE, client and redirect checked), the
 * revocation, the calendar list and the events with etags, `If-Match` and push
 * channels. Nothing here reaches the internet. Google's consent page itself is
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

export interface DevEvent {
  id: string;
  etag: string;
  status?: string;
  summary?: string;
  location?: string;
  description?: string;
  start: { date?: string; dateTime?: string; timeZone?: string };
  end: { date?: string; dateTime?: string; timeZone?: string };
  attendees?: unknown[];
  recurringEventId?: string;
}

export interface DevGoogle {
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
  /** Makes every call answer this status (a Google outage), or null. */
  outage: number | null;
  handle(request: Request): Promise<Response | null>;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const random = () => toBase64Url(crypto.getRandomValues(new Uint8Array(16)));

async function s256(verifier: string): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

const GOOGLE_HOSTS = new Set(["oauth2.googleapis.com", "www.googleapis.com"]);
const SCOPES = ["https://www.googleapis.com/auth/calendar.calendarlist.readonly", "https://www.googleapis.com/auth/calendar.events"];

export function devGoogle(options: { clientId?: string | undefined; clientSecret?: string | undefined; calendars?: DevCalendar[] } = {}): DevGoogle {
  let version = 1;
  const nextEtag = () => `"${version++}"`;
  const google: DevGoogle = {
    clientId: options.clientId ?? "dev-client.apps.googleusercontent.com",
    clientSecret: options.clientSecret ?? "dev-secret",
    calendars: options.calendars ?? [
      { id: "dono@exemplo.com.br", summary: "dono@exemplo.com.br", accessRole: "owner", primary: true, backgroundColor: "#4f7cff", timeZone: "America/Sao_Paulo" },
      { id: "trabalho@group.exemplo.com.br", summary: "Trabalho", accessRole: "writer", backgroundColor: "#16a34a" },
      { id: "consultorio@group.exemplo.com.br", summary: "Consultório", accessRole: "reader", backgroundColor: "#f59e0b" },
      { id: "livre@group.exemplo.com.br", summary: "Livre e ocupado", accessRole: "freeBusyReader" },
    ],
    events: new Map(),
    grant: null,
    refreshTokens: new Set(),
    accessTokens: new Set(),
    revoked: [],
    channels: new Map(),
    seen: [],
    outage: null,
    async handle(request) {
      const url = new URL(request.url);
      if (!GOOGLE_HOSTS.has(url.hostname)) return null;
      const body = request.method === "GET" || request.method === "DELETE" ? "" : await request.text();
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headers[key] = value;
      });
      google.seen.push({ url: url.href, method: request.method, body, headers });
      if (google.outage) return json({ error: { code: google.outage } }, google.outage);
      if (url.hostname === "oauth2.googleapis.com") return token(url, body);
      const auth = request.headers.get("authorization") ?? "";
      if (!auth.startsWith("Bearer ") || !google.accessTokens.has(auth.slice(7))) return json({ error: { code: 401 } }, 401);
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
      if (!/\/configuracoes\/integracoes$/.test(form.get("redirect_uri") ?? "")) return json({ error: "redirect_uri_mismatch" }, 400);
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
      return json({ kind: "api#channel", id: input.id, resourceId, expiration: String(Date.now() + 7 * 86_400_000) });
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
      const updated: DevEvent = { ...event, ...patch, id: event.id, etag: nextEtag() };
      events[index] = updated;
      return json(updated);
    }
    if (method === "DELETE") {
      events.splice(index, 1);
      return new Response(null, { status: 204 });
    }
    return json({ error: { code: 405 } }, 405);
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
  const now = new Date();
  // Local dates written for America/Sao_Paulo (UTC-3), the sample owner's zone.
  const day = (offset: number) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset));
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
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
  add("trabalho@group.exemplo.com.br", "Reunião de planejamento", { dateTime: at(0, 14) }, { dateTime: at(0, 15, 30) }, { attendees: [{}, {}, {}] });
  add("trabalho@group.exemplo.com.br", "Revisão do projeto", { dateTime: at(2, 10) }, { dateTime: at(2, 11) });
  add("consultorio@group.exemplo.com.br", "Atendimento", { dateTime: at(0, 16) }, { dateTime: at(0, 17) });
  add("consultorio@group.exemplo.com.br", "Atendimento", { dateTime: at(1, 8) }, { dateTime: at(1, 9) });
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
