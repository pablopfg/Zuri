import { useQueryClient } from "@tanstack/react-query";
import { type SessionState, sessionStateSchema } from "@zuri/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { SESSION_KEY, useSession } from "../hooks/session.tsx";
import { lastReportedAt, lastUseAt, markUse, noteReported } from "../lib/activity.ts";
import { api } from "../lib/api.ts";
import { formatCountdown, sessionEnd, toLocal, WARN_BEFORE_MS } from "../lib/deadlines.ts";
import { useI18n } from "../lib/i18n.tsx";
import { Button, Dialog } from "./ui.tsx";

/** The tab holding this lock sends the presence signal for all of them. */
const LEADER_LOCK = "zuri-heartbeat";
const HEARTBEAT_MS = 60_000;
// Not "scroll": the page can scroll by itself, and that is not use.
const INPUT_EVENTS = ["pointerdown", "keydown", "touchstart", "wheel"] as const;
/** A tab must be in front this long before its own count may sign the whole browser out. */
const SETTLE_MS = 5_000;

/**
 * Makes the server's session limits visible: notices real use, sends one
 * presence signal a minute for all open tabs, warns two minutes before the
 * session ends for lack of use, and signs out every tab when it does. The
 * server enforces the same limits on every request; this only ends it cleanly.
 */
export function SessionGuard({ session }: { session: SessionState }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { signOut, lock } = useSession();
  const [deadlines, setDeadlines] = useState(() => toLocal(session.deadlines));
  const [now, setNow] = useState(Date.now());
  const lastBeat = useRef(Date.now());
  const ending = useRef(false);
  const visibleSince = useRef(Date.now());

  useEffect(() => setDeadlines(toLocal(session.deadlines)), [session.deadlines]);

  const beat = useCallback(
    async (active: boolean) => {
      lastBeat.current = Date.now();
      if (active) noteReported();
      try {
        const state = sessionStateSchema.parse(await api<unknown>("/auth/heartbeat", { method: "POST", body: { active } }));
        qc.setQueryData(SESSION_KEY, state);
      } catch {
        // A 401 signs out through the API client; a network error waits for the next beat.
      }
    },
    [qc],
  );

  useEffect(() => {
    const onInput = () => markUse();
    for (const name of INPUT_EVENTS) window.addEventListener(name, onInput, { passive: true, capture: true });
    return () => {
      for (const name of INPUT_EVENTS) window.removeEventListener(name, onInput, { capture: true });
    };
  }, []);

  // One tab (the lock holder) sends the presence signal; without Web Locks every tab does.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const lead = () => {
      timer = setInterval(() => void beat(lastUseAt() > lastBeat.current), HEARTBEAT_MS);
    };
    const release = new AbortController();
    if (navigator.locks) {
      navigator.locks
        .request(LEADER_LOCK, { signal: release.signal }, () => {
          lead();
          return new Promise<void>((resolve) => release.signal.addEventListener("abort", () => resolve()));
        })
        .catch(() => {
          // Aborted on unmount.
        });
    } else {
      lead();
    }
    return () => {
      clearInterval(timer);
      release.abort();
    };
  }, [beat]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") visibleSince.current = Date.now();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const end = sessionEnd(deadlines, lastReportedAt());
  const remaining = end.at - now;
  // Use the server hasn't heard of yet renews the session before any warning shows.
  const unreported = lastUseAt() > lastBeat.current;
  const warn = remaining > 0 && remaining <= WARN_BEFORE_MS && !(unreported && end.reason === "idle");

  useEffect(() => {
    if (remaining <= WARN_BEFORE_MS && remaining > 0 && unreported && end.reason === "idle" && Date.now() - lastBeat.current > 5_000) void beat(true);
  }, [remaining, unreported, end.reason, beat]);

  useEffect(() => {
    if (remaining > 0 || ending.current) return;
    ending.current = true;
    // A tab just back from the background may count from stale news: it locks
    // only itself and asks the server, never signing out a session in use elsewhere.
    if (document.visibilityState !== "visible" || Date.now() - visibleSince.current < SETTLE_MS) {
      lock(end.reason);
      return;
    }
    void signOut(end.reason);
  }, [remaining, end.reason, signOut, lock]);

  if (!warn) return null;
  const maxReached = end.reason === "ended";
  return (
    <Dialog open onClose={() => void beat(true)} title={t("web.guard.title")}>
      <p className="text-sm leading-6 text-fg-muted" aria-live="polite" aria-atomic="true">
        {maxReached ? t("web.guard.max", { time: formatCountdown(remaining) }) : t("web.guard.idle", { time: formatCountdown(remaining) })}
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => void signOut("manual")}>
          {t("web.nav.signOut")}
        </Button>
        {!maxReached && (
          <Button autoFocus onClick={() => void beat(true)}>
            {t("web.guard.stay")}
          </Button>
        )}
      </div>
    </Dialog>
  );
}
