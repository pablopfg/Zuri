/**
 * The areas of the screens whose changes the app learns without reloading
 * (nova UI, PR 2): each has a number on the server that goes up with every
 * change, whoever made it. The heartbeat and the chat's tool events carry the
 * numbers; a screen fetches again only the area whose number moved.
 */
export const AREAS = ["tasks", "projects", "notes", "trash", "memories", "automations", "conversations"] as const;
export type Area = (typeof AREAS)[number];
/** Numbers only, never content. An area left out is one this server does not count. */
export type AreaVersions = Partial<Record<Area, number>>;

/** Tasks per view of the Tasks screen, and "today" for the side menu. */
export interface TaskCounts {
  today: number;
  upcoming: number;
  overdue: number;
  completed: number;
  all: number;
}
