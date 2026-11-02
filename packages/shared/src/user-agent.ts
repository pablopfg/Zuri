/**
 * A short "Browser on System" for a user agent, for the activity list. Only
 * well-known names are recognized; anything else shows nothing rather than a
 * guess. The raw string stays available as the row's detail.
 */
export function describeUserAgent(ua: string): { browser: string | null; system: string | null } {
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /SamsungBrowser\//.test(ua)
          ? "Samsung Internet"
          : /Chrome\//.test(ua)
            ? "Chrome"
            : /Version\/[\d.]+.*Safari\//.test(ua)
              ? "Safari"
              : null;
  const system = /Android/.test(ua)
    ? "Android"
    : /iPhone|iPad|iPod/.test(ua)
      ? "iOS"
      : /Windows/.test(ua)
        ? "Windows"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /CrOS/.test(ua)
            ? "ChromeOS"
            : /Linux/.test(ua)
              ? "Linux"
              : null;
  return { browser, system };
}
