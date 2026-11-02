import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { AutomationList, AutomationRunPage } from "@zuri/shared";
import { api } from "../lib/api.ts";

/** Everything about automations starts with this key, so one invalidation refreshes the list, counts and history. */
export const AUTOMATIONS_KEY = ["automations"] as const;

export function useAutomations() {
  return useQuery({
    queryKey: [...AUTOMATIONS_KEY, "list"],
    queryFn: ({ signal }) => api<AutomationList>("/automations", { signal }),
  });
}

/** The run history, newest first, one page (30 runs) at a time. */
export function useAutomationRuns() {
  return useInfiniteQuery({
    queryKey: [...AUTOMATIONS_KEY, "runs"],
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) => api<AutomationRunPage>(`/automations/runs${pageParam ? `?before=${encodeURIComponent(pageParam)}` : ""}`, { signal }),
    getNextPageParam: (last) => last.nextCursor,
  });
}
