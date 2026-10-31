/**
 * Gate 4: security headers. The interface's set mirrors apps/web/public/_headers
 * (a test keeps the two equal): with run_worker_first every asset passes through
 * this Worker, and Cloudflare does not apply _headers to responses the Worker
 * returns. Change both together.
 */
export const WEB_HEADERS = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "cross-origin-opener-policy": "same-origin",
  "strict-transport-security": "max-age=63072000; includeSubDomains",
} as const satisfies Record<string, string>;

/** API answers are data, never pages: nothing in them may load, run or be framed. */
export const API_HEADERS = {
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  // Browsers ignore HSTS received over plain HTTP, so it is safe on every answer.
  "strict-transport-security": WEB_HEADERS["strict-transport-security"],
  "cache-control": "no-store",
} as const satisfies Record<string, string>;

/**
 * Cache rules as in _headers: hashed bundles forever, the app shell and the
 * service worker always revalidated. The shell also answers client-side routes
 * ("/", "/chat"), hence the content-type check.
 */
export function webCacheControl(pathname: string, contentType: string | null, ok: boolean): string | null {
  const html = contentType?.startsWith("text/html") ?? false;
  // A missing bundle falls back to the HTML shell, which must never be cached for a year.
  if (pathname.startsWith("/assets/") && ok && !html) return "public, max-age=31536000, immutable";
  if (pathname === "/index.html" || pathname === "/sw.js" || html) return "no-cache";
  return null;
}

/**
 * The interface's CSP. With Turnstile on, the sign-in loads Cloudflare's widget
 * script and its frame from that one origin; with it off (the default) nothing
 * outside the Worker's own origin may load, exactly as in _headers.
 */
export function webCsp(turnstileOrigin: string | null): string {
  const base = WEB_HEADERS["content-security-policy"];
  if (!turnstileOrigin) return base;
  return base
    .replace("script-src 'self'", `script-src 'self' ${turnstileOrigin}`)
    .replace("style-src 'self'", `frame-src ${turnstileOrigin}; style-src 'self'`);
}

/** A copy of the asset response with the interface's headers. */
export function withWebHeaders(response: Response, pathname: string, turnstileOrigin: string | null = null): Response {
  const res = new Response(response.body, response);
  for (const [name, value] of Object.entries(WEB_HEADERS)) res.headers.set(name, value);
  res.headers.set("content-security-policy", webCsp(turnstileOrigin));
  const cache = webCacheControl(pathname, res.headers.get("content-type"), res.ok);
  if (cache) res.headers.set("cache-control", cache);
  return res;
}

/** A copy of an API or gate response with the API's headers. */
export function withApiHeaders(response: Response): Response {
  // A 101 (WebSocket) can't be copied; the gates refuse upgrades long before one could exist.
  const res = new Response(response.body, response);
  for (const [name, value] of Object.entries(API_HEADERS)) res.headers.set(name, value);
  return res;
}
