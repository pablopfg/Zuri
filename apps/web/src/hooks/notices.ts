import { type QueryClient, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { AlertOverview, DiagnosticsReport, NoticePage, SessionState } from "@zuri/shared";
import { api } from "../lib/api.ts";
import { SESSION_KEY } from "./session.tsx";

/** The notice list, the delivery history and the failure log: one prefix, so a change refreshes them together. */
export const NOTICES_KEY = ["notices"] as const;
export const ALERTS_KEY = ["alerts"] as const;
export const DIAGNOSTICS_KEY = ["diagnostics"] as const;

/** The panel's list, newest first, 50 at a time. */
export function useNotices(enabled = true) {
  return useInfiniteQuery({
    queryKey: [...NOTICES_KEY, "list"],
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) => api<NoticePage>(`/notices${pageParam ? `?before=${encodeURIComponent(pageParam)}` : ""}`, { signal }),
    getNextPageParam: (last) => last.nextCursor,
    enabled,
  });
}

export function useAlertOverview() {
  return useQuery({ queryKey: ALERTS_KEY, queryFn: ({ signal }) => api<AlertOverview>("/alerts", { signal }) });
}

export function useDiagnostics() {
  return useQuery({ queryKey: DIAGNOSTICS_KEY, queryFn: ({ signal }) => api<DiagnosticsReport>("/diagnostics", { signal }) });
}

/** The bell reads its count from the session: a change made here shows on it at once, before the next heartbeat. */
export function setUnread(qc: QueryClient, unread: number): void {
  qc.setQueryData<SessionState | null>(SESSION_KEY, (session) => (session ? { ...session, unreadNotices: unread } : session));
}
