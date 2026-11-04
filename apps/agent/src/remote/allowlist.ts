import { REMOTE_EVENTS_PATH, type RemoteScope } from "@zuri/shared";

/** A record's id in an allowed path: a UUID, as the server makes them. */
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What a read token reaches (GET; HEAD is the same route). Exact paths; ":id" is a UUID. */
const READ = new Set([
  "GET /api/health",
  "GET /api/tasks",
  "GET /api/tasks/counts",
  "GET /api/tasks/:id",
  "GET /api/notes",
  "GET /api/notes/:id",
  "GET /api/projects",
  "GET /api/memories",
  "GET /api/memories/:id",
  "GET /api/automations",
  "GET /api/automations/:id",
]);

/**
 * What a write token also reaches. Tasks and notes it deletes go to the
 * 30-day trash; memories and automations have no trash, so a token never
 * deletes them (an automation can be paused instead). Creating or changing a
 * routine with AI is refused in the automations' routes.
 */
const WRITE = new Set([
  "POST /api/tasks",
  "PATCH /api/tasks/:id",
  "DELETE /api/tasks/:id",
  "POST /api/notes",
  "PATCH /api/notes/:id",
  "DELETE /api/notes/:id",
  "POST /api/memories",
  "PATCH /api/memories/:id",
  "POST /api/automations",
  "PATCH /api/automations/:id",
]);

/**
 * Default deny (step 20): true only for the routes a token of this scope may
 * call. The path is matched as it arrived: a percent-encoded, doubled or
 * trailing slash variant of an allowed route is refused, never decoded into
 * one. An events token reaches POST /api/remote/events and nothing else, and
 * no other token reaches that one.
 */
export function remoteAllowed(scope: RemoteScope, method: string, path: string): boolean {
  if (scope === "events") return method === "POST" && path === REMOTE_EVENTS_PATH;
  const route = `${method === "HEAD" ? "GET" : method} ${pattern(path)}`;
  return READ.has(route) || (scope === "write" && WRITE.has(route));
}

/** The path with a last segment that is a UUID written as ":id". Anything odd stays as it is and matches nothing. */
function pattern(path: string): string {
  // ":id" is only ever ours: a path that carries a colon itself matches nothing.
  if (path.includes(":")) return "";
  const cut = path.lastIndexOf("/");
  const last = path.slice(cut + 1);
  return ID.test(last) ? `${path.slice(0, cut)}/:id` : path;
}

/** True for a method that changes something: a read token never sends one. */
export function isWrite(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}
