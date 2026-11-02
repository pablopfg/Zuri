import { useQuery } from "@tanstack/react-query";
import { setupStatusSchema } from "@zuri/shared";
import { api } from "../lib/api.ts";

export const SETUP_STATUS_KEY = ["setup-status"] as const;

/** Whether the first access is still to be done (no owner yet). The answer never says whether a code is set. */
export function useSetupStatus(enabled = true) {
  return useQuery({
    queryKey: SETUP_STATUS_KEY,
    queryFn: async () => setupStatusSchema.parse(await api<unknown>("/setup")),
    staleTime: 60_000,
    retry: 1,
    enabled,
  });
}
