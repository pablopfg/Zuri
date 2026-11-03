import { useQuery } from "@tanstack/react-query";
import type { TaskCounts } from "@zuri/shared";
import { api } from "../lib/api.ts";

/**
 * How many tasks each view holds: the side menu shows Today's, the Tasks tabs
 * all of them. Under "tasks", so a change to the tasks (here, in the chat or
 * elsewhere, through lib/versions.ts) refreshes it with the lists.
 */
export function useTaskCounts() {
  return useQuery({ queryKey: ["tasks", "counts"], queryFn: ({ signal }) => api<{ counts: TaskCounts }>("/tasks/counts", { signal }) });
}
