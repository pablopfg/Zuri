import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Settings, SettingsUpdate } from "@zuri/shared";
import { api } from "../lib/api.ts";
import { SETTINGS_KEY } from "./session.tsx";

export function useSettings() {
  return useQuery({ queryKey: SETTINGS_KEY, queryFn: () => api<Settings>("/settings"), staleTime: 5 * 60_000 });
}

/** Saves a change; the answer (the settings as stored) replaces what the screens show. */
export function useSettingsMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: SettingsUpdate) => api<Settings>("/settings", { method: "PATCH", body: patch }),
    onSuccess: (settings) => qc.setQueryData(SETTINGS_KEY, settings),
  });
}
