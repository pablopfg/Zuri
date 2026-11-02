const sent = new Set<string>();

/**
 * Tells the Diagnóstico tab that a screen broke: only the error's name and the
 * screen's path, ids swapped for "id", never the message or the stack (they
 * can carry what the owner typed). Once per kind per page load; the server
 * takes at most 20 an hour. Never throws and never waits. The CSRF header's
 * name comes from the caller: importing it here would split the shared code
 * of the first load into one more chunk (armadilhas.md, "Pacote da interface").
 */
export function reportClientError(error: unknown, csrfHeader: string, path = window.location.pathname): void {
  const raw = error instanceof Error ? error.name : "";
  const name = /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(raw) ? raw : "Error";
  const route =
    (path.split(/[?#]/)[0] ?? "")
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "id")
      .replace(/[^A-Za-z0-9/_-]/g, "")
      .slice(0, 120) || "/";
  const key = `${name} ${route}`;
  if (sent.has(key)) return;
  sent.add(key);
  void fetch("/api/diagnostics/client", {
    method: "POST",
    headers: { "content-type": "application/json", [csrfHeader]: "1" },
    body: JSON.stringify({ name, route: route.startsWith("/") ? route : `/${route}` }),
    keepalive: true,
  }).catch(() => undefined);
}
