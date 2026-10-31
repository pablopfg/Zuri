import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { type SessionState, type Settings, sessionStateSchema } from "@zuri/shared";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { broadcast, type EndReason, onSessionMessage } from "../lib/activity.ts";
import { ApiError, api, onPasswordChangeRequired, onUnauthorized } from "../lib/api.ts";
import { useI18n } from "../lib/i18n.tsx";

export const SESSION_KEY = ["session"] as const;
export const SETTINGS_KEY = ["settings"] as const;

/** The session, or null when this browser is signed out (the server answered 401). */
async function fetchSession(): Promise<SessionState | null> {
  try {
    return sessionStateSchema.parse(await api<unknown>("/auth/session"));
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

interface SessionValue {
  session: SessionState | null | undefined;
  loading: boolean;
  error: unknown;
  retry: () => void;
  /** Why the last session of this tab ended, for the sign-in screen. */
  ended: EndReason | null;
  /** A sign-in finished: the state the server answered with. */
  signedIn: (state: SessionState) => void;
  /** Signs out here, in every other tab and on the server. */
  signOut: (reason?: EndReason | "manual") => Promise<void>;
  /** Locks this tab only and asks the server, without signing out a session in use elsewhere. */
  lock: (reason: EndReason) => void;
}

const SessionContext = createContext<SessionValue | null>(null);

/** Drops every private answer from memory, keeping only the (now empty) session. */
function forgetData(qc: QueryClient) {
  qc.removeQueries({ predicate: (q) => q.queryKey[0] !== SESSION_KEY[0] });
  qc.setQueryData(SESSION_KEY, null);
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { adoptSettings } = useI18n();
  const [ended, setEnded] = useState<EndReason | null>(null);
  const query = useQuery({ queryKey: SESSION_KEY, queryFn: fetchSession, staleTime: 60_000, retry: 1 });
  const signedIn = Boolean(query.data);

  // The owner's language and zone, once signed in.
  const settings = useQuery({ queryKey: SETTINGS_KEY, queryFn: () => api<Settings>("/settings"), enabled: signedIn, staleTime: 5 * 60_000 });
  useEffect(() => {
    if (settings.data) adoptSettings(settings.data);
  }, [settings.data, adoptSettings]);

  const endHere = useCallback(
    (reason: EndReason | "manual") => {
      setEnded(reason === "manual" ? null : reason);
      forgetData(qc);
    },
    [qc],
  );

  // A signed-in request got 401: the server ended the session.
  useEffect(
    () =>
      onUnauthorized(() => {
        if (qc.getQueryData(SESSION_KEY)) endHere("ended");
      }),
    [qc, endHere],
  );

  useEffect(() => onPasswordChangeRequired(() => void qc.invalidateQueries({ queryKey: SESSION_KEY })), [qc]);

  // Signing out in one tab signs out every tab.
  useEffect(
    () =>
      onSessionMessage((m) => {
        if (m.type === "signed-out" && qc.getQueryData(SESSION_KEY)) endHere(m.reason);
      }),
    [qc, endHere],
  );

  // Back to a tab (or a page restored by the Back button): ask the server before showing data again.
  useEffect(() => {
    const check = () => void qc.invalidateQueries({ queryKey: SESSION_KEY });
    const onVisible = () => document.visibilityState === "visible" && check();
    const onPageShow = (e: PageTransitionEvent) => e.persisted && check();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [qc]);

  const signOut = useCallback(
    async (reason: EndReason | "manual" = "manual") => {
      broadcast({ type: "signed-out", reason });
      // The screen locks at once; the server's answer can't bring the data back.
      endHere(reason);
      try {
        await api("/auth/logout", { method: "POST" });
      } catch {
        // Already signed out there, or offline: the server ends it on its own deadline.
      }
    },
    [endHere],
  );

  const lock = useCallback(
    (reason: EndReason) => {
      endHere(reason);
      void qc.invalidateQueries({ queryKey: SESSION_KEY });
    },
    [endHere, qc],
  );

  const value = useMemo<SessionValue>(
    () => ({
      session: query.data,
      loading: query.isPending,
      error: query.error,
      retry: () => void query.refetch(),
      ended,
      signedIn: (state) => {
        setEnded(null);
        qc.setQueryData(SESSION_KEY, state);
      },
      signOut,
      lock,
    }),
    [query.data, query.isPending, query.error, query.refetch, ended, qc, signOut, lock],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession outside SessionProvider");
  return value;
}
