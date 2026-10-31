import { useQuery } from "@tanstack/react-query";
import type { Memory, MemoryCategory, MemoryCounts, MemoryFilter, MemoryHistory, MemoryReview } from "@zuri/shared";
import { api } from "../lib/api.ts";

/** Everything about memories starts with this key, so one invalidation refreshes lists, counts and reviews. */
export const MEMORIES_KEY = ["memories"] as const;

export interface MemoryQuery {
  filter: MemoryFilter;
  category: MemoryCategory | "";
  q: string;
}

export function useMemories(query: MemoryQuery) {
  return useQuery({
    queryKey: [...MEMORIES_KEY, "list", query],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ status: query.filter });
      if (query.category) params.set("category", query.category);
      if (query.q) params.set("q", query.q);
      return api<{ memories: Memory[]; counts: MemoryCounts }>(`/memories?${params}`, { signal });
    },
    placeholderData: (previous) => previous,
  });
}

/** Asked only when the counters say there is something to review. */
export function useMemoryReviews(enabled: boolean) {
  return useQuery({
    queryKey: [...MEMORIES_KEY, "reviews"],
    queryFn: ({ signal }) => api<{ reviews: MemoryReview[] }>("/memories/reviews", { signal }),
    enabled,
  });
}

export function useMemoryHistory(id: string | null) {
  return useQuery({
    queryKey: [...MEMORIES_KEY, "history", id],
    queryFn: ({ signal }) => api<MemoryHistory>(`/memories/${id}/history`, { signal }),
    enabled: id !== null,
  });
}
