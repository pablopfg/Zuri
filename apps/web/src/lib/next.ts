/** Where the app opens after sign-in when no safe destination was asked for. */
export const HOME_PATH = "/";
export const LOGIN_PATH = "/entrar";

/**
 * The page to open after signing in, from the `?next=` of the sign-in screen.
 * Only a path of this app counts: an absolute URL, a protocol-relative "//host",
 * a backslash ("/\host" reads as "//host" in browsers), control characters or
 * the sign-in page itself fall back to the home page, so the parameter can never
 * send the owner to another site.
 */
export function safeNext(value: string | null | undefined): string {
  if (!value || value.length > 512 || !value.startsWith("/") || value.startsWith("//")) return HOME_PATH;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point.
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return HOME_PATH;
  let url: URL;
  try {
    url = new URL(value, "https://zuri.invalid");
  } catch {
    return HOME_PATH;
  }
  if (url.origin !== "https://zuri.invalid" || url.pathname === LOGIN_PATH) return HOME_PATH;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The sign-in address that comes back to `path` afterwards. */
export function loginPath(path: string): string {
  const next = safeNext(path);
  return next === HOME_PATH ? LOGIN_PATH : `${LOGIN_PATH}?next=${encodeURIComponent(next)}`;
}
