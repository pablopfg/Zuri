import { useQuery } from "@tanstack/react-query";
import { type UsageReport, usageReportSchema } from "@zuri/shared";
import { api } from "../lib/api.ts";

export const USAGE_KEY = ["usage"] as const;

/** Today's AI use against the limits. Refetched when the tab is opened again, never polled (rule P11). */
export function useUsage() {
  return useQuery({
    queryKey: USAGE_KEY,
    queryFn: async ({ signal }): Promise<UsageReport> => usageReportSchema.parse(await api<unknown>("/usage", { signal })),
    staleTime: 15_000,
  });
}
