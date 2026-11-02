import { AUTOMATION_LIMITS, type MessageKey, nextRun, type Schedule, type ScheduleType, zonedParts } from "@zuri/shared";

/**
 * The Automations screen's rules, without React: how a schedule reads to the
 * owner, and how the form's fields become the schedule the server takes.
 */

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

const DAY_LONG = [
  "web.automations.dayLong.0",
  "web.automations.dayLong.1",
  "web.automations.dayLong.2",
  "web.automations.dayLong.3",
  "web.automations.dayLong.4",
  "web.automations.dayLong.5",
  "web.automations.dayLong.6",
] as const satisfies readonly MessageKey[];

/** "a, b e c": the last two joined by the language's "and". */
export function joinList(items: readonly string[], t: Translate): string {
  if (items.length <= 1) return items[0] ?? "";
  return t("web.automations.schedule.and", { list: items.slice(0, -1).join(", "), last: items.at(-1) ?? "" });
}

const capitalize = (text: string) => (text ? (text[0] as string).toLocaleUpperCase() + text.slice(1) : text);

/**
 * A schedule in the owner's words: "Todo dia às 08:00", "De segunda a sexta às
 * 07:30", "A cada 2 horas". A one-time moment goes through `dateTime`, so it
 * reads like every other date on the screen.
 */
export function describeSchedule(schedule: Schedule, t: Translate, timeZone: string, dateTime: (value: Date) => string): string {
  switch (schedule.type) {
    case "once": {
      // From the start of time, the next run of a one-time moment is that moment.
      const at = nextRun(schedule, timeZone, new Date(0));
      return t("web.automations.schedule.once", { when: at ? dateTime(at) : schedule.at.replace("T", " ") });
    }
    case "daily":
      return t("web.automations.schedule.daily", { time: schedule.time });
    case "weekly": {
      const days = [...schedule.days].sort((a, b) => a - b);
      const key = days.join();
      if (key === "0,1,2,3,4,5,6") return t("web.automations.schedule.daily", { time: schedule.time });
      if (key === "1,2,3,4,5") return t("web.automations.schedule.weekdays", { time: schedule.time });
      if (key === "0,6") return t("web.automations.schedule.weekend", { time: schedule.time });
      // Monday first, as the week reads in the calendar; Sunday last.
      const ordered = [...days.filter((d) => d !== 0), ...days.filter((d) => d === 0)];
      return t("web.automations.schedule.weekly", { days: capitalize(joinList(ordered.map((d) => t(DAY_LONG[d] as MessageKey)), t)), time: schedule.time });
    }
    case "monthly":
      return t(schedule.day > 28 ? "web.automations.schedule.monthlyEnd" : "web.automations.schedule.monthly", { day: schedule.day, time: schedule.time });
    case "interval": {
      const hours = schedule.minutes / 60;
      return hours === 1 ? t("web.automations.schedule.hourly") : t("web.automations.schedule.hours", { hours });
    }
  }
}

/** What the form holds: every frequency's fields at once, so switching back and forth keeps what was typed. */
export interface ScheduleDraft {
  type: ScheduleType;
  date: string;
  time: string;
  days: number[];
  day: string;
  hours: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A new form: tomorrow at 09:00 for a one-time moment, weekdays for a weekly one, today's day of the month. */
export function emptyDraft(timeZone: string, now: Date): ScheduleDraft {
  const today = zonedParts(now, timeZone);
  const tomorrow = zonedParts(new Date(now.getTime() + 24 * 3_600_000), timeZone);
  return {
    type: "daily",
    date: `${tomorrow.year}-${pad(tomorrow.month)}-${pad(tomorrow.day)}`,
    time: "09:00",
    days: [1, 2, 3, 4, 5],
    day: String(today.day),
    hours: "2",
  };
}

/** The form opened on an existing schedule. */
export function draftOf(schedule: Schedule, timeZone: string, now: Date): ScheduleDraft {
  const draft = { ...emptyDraft(timeZone, now), type: schedule.type };
  switch (schedule.type) {
    case "once":
      return { ...draft, date: schedule.at.slice(0, 10), time: schedule.at.slice(11, 16) };
    case "daily":
      return { ...draft, time: schedule.time };
    case "weekly":
      return { ...draft, days: [...schedule.days], time: schedule.time };
    case "monthly":
      return { ...draft, day: String(schedule.day), time: schedule.time };
    case "interval":
      return { ...draft, hours: String(schedule.minutes / 60) };
  }
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The schedule the fields describe, or null while something is missing or out of range (the server checks again). */
export function scheduleOf(draft: ScheduleDraft): Schedule | null {
  const time = draft.time.slice(0, 5);
  switch (draft.type) {
    case "once":
      return DATE.test(draft.date) && TIME.test(time) ? { type: "once", at: `${draft.date}T${time}` } : null;
    case "daily":
      return TIME.test(time) ? { type: "daily", time } : null;
    case "weekly": {
      const days = [...new Set(draft.days)].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort((a, b) => a - b);
      return days.length > 0 && TIME.test(time) ? { type: "weekly", days, time } : null;
    }
    case "monthly": {
      const day = Number(draft.day);
      return /^\d{1,2}$/.test(draft.day) && day >= 1 && day <= 31 && TIME.test(time) ? { type: "monthly", day, time } : null;
    }
    case "interval": {
      const hours = Number(draft.hours);
      const min = AUTOMATION_LIMITS.minIntervalMinutes / 60;
      const max = Math.floor(AUTOMATION_LIMITS.maxIntervalMinutes / 60);
      return /^\d{1,4}$/.test(draft.hours) && hours >= min && hours <= max ? { type: "interval", minutes: hours * 60 } : null;
    }
  }
}

/** The anchor the chat links to, so "Revisar em Automações" lands on that automation. */
export const automationAnchor = (id: string) => `automacao-${id}`;
