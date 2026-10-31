import { useEffect, useRef } from "react";
import { useI18n } from "../lib/i18n.tsx";

/** Cloudflare's script. The CSP allows this one origin only while Turnstile is on (gates/headers.ts). */
const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileApi {
  render(container: HTMLElement, options: Record<string, unknown>): string;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | null = null;

/** Loads the script once, and only when a sign-in asks for the check. */
function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("turnstile")));
    script.onerror = () => {
      loading = null;
      script.remove();
      reject(new Error("turnstile"));
    };
    document.head.append(script);
  });
  return loading;
}

/**
 * The "not a robot" check on the sign-in form. Hands its token through onToken,
 * and null when it expires or fails. A token works once: give it a new `key`
 * after each try. Discreet: it draws nothing unless Cloudflare needs a click,
 * and then onInteractive tells the form to say why the box appeared.
 */
export function TurnstileWidget({
  siteKey,
  onToken,
  onError,
  onInteractive,
}: {
  siteKey: string;
  onToken: (token: string | null) => void;
  onError: () => void;
  onInteractive?: (shown: boolean) => void;
}) {
  const { locale } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  // The latest callbacks, without drawing the widget again when they change.
  const callbacks = useRef({ onToken, onError, onInteractive });
  callbacks.current = { onToken, onError, onInteractive };

  useEffect(() => {
    let widgetId: string | null = null;
    let cancelled = false;
    loadTurnstile()
      .then((turnstile) => {
        if (cancelled || !ref.current) return;
        widgetId = turnstile.render(ref.current, {
          sitekey: siteKey,
          action: "login",
          theme: "auto",
          size: "flexible",
          appearance: "interaction-only",
          "before-interactive-callback": () => callbacks.current.onInteractive?.(true),
          "after-interactive-callback": () => callbacks.current.onInteractive?.(false),
          language: locale.toLowerCase(),
          callback: (token: string) => callbacks.current.onToken(token),
          "expired-callback": () => callbacks.current.onToken(null),
          "error-callback": () => {
            callbacks.current.onToken(null);
            callbacks.current.onError();
          },
        });
      })
      .catch(() => {
        if (!cancelled) callbacks.current.onError();
      });
    return () => {
      cancelled = true;
      if (widgetId !== null) window.turnstile?.remove(widgetId);
    };
  }, [siteKey, locale]);

  return <div ref={ref} />;
}
