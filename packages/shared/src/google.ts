/**
 * The Google Calendar (step 19): one Google account, connected with OAuth and
 * the owner's own confidential client. Each of its calendars is hidden from
 * Zuri (the default), read only, or readable and writable. The interface uses
 * only the types and constants here; the schemas run on the server (rule P11).
 */

/** What Zuri may do in one calendar. */
export const CALENDAR_MODES = ["off", "read", "write"] as const;
export type CalendarMode = (typeof CALENDAR_MODES)[number];

/**
 * Where Google sends the browser back: the Integrations page, as for the MCP
 * sign-ins (step 18b). The state starts with this prefix, so the page knows
 * the answer is Google's.
 */
export const GOOGLE_CALLBACK_PATH = "/configuracoes/integracoes";
export const GOOGLE_STATE_PREFIX = "g.";

/** Why the connection needs the owner: Google refused the stored access, or the key that seals it changed. */
export const GOOGLE_PROBLEMS = ["revoked", "credential_unreadable"] as const;
export type GoogleProblem = (typeof GOOGLE_PROBLEMS)[number];

export const GOOGLE_LIMITS = {
  /** Calendars read from the account's list; the rest is left out. */
  maxCalendars: 100,
  calendarNameMax: 120,
  /** How long the owner has to answer Google's page. */
  stateMs: 10 * 60_000,
  /** The longest window one listing covers, and the events it returns. */
  listDays: 62,
  listEvents: 50,
  /** Calendars read by one listing. */
  listCalendars: 10,
  titleMax: 200,
  locationMax: 300,
  descriptionMax: 2_000,
  /** An event with a time lasts at most this. */
  eventDaysMax: 14,
} as const;

export interface GoogleCalendarInfo {
  id: string;
  name: string;
  /** Google's role for the account: owner, writer, reader or freeBusyReader. */
  accessRole: string;
  primary: boolean;
  mode: CalendarMode;
  /** Whether Google lets the account change events there (owner or writer). */
  writable: boolean;
  /** Google's color for it ("#rrggbb"), for the Agenda screen. */
  color?: string;
}

export interface GoogleStatus {
  /** GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and MCP_CREDENTIAL_KEY are set. */
  configured: boolean;
  connected: boolean;
  /** The account's main calendar (its e-mail), the owner's own. */
  account: string | null;
  status: "connected" | "error" | null;
  problem: GoogleProblem | null;
  connectedAt: string | null;
  calendars: GoogleCalendarInfo[];
}

/** An event as the Agenda screen gets it (times as Google keeps them; text cleaned on the server). */
export interface AgendaEvent {
  id: string;
  calendarId: string;
  title: string;
  /** ISO instant, or "YYYY-MM-DD" for an all-day event. */
  start: string;
  /** Exclusive end: ISO instant, or the day after the last one. */
  end: string;
  allDay: boolean;
  location: string;
  description: string;
  etag: string;
  recurring: boolean;
  guests: number;
}

export interface AgendaPage {
  events: AgendaEvent[];
  /** Past the screen's limit: some events of the window were left out. */
  more: boolean;
  /** The calendars open to Zuri, with what each allows. */
  calendars: GoogleCalendarInfo[];
}

/** Events the Agenda screen reads per calendar and in total for one window (six weeks for the month). */
export const AGENDA_LIMITS = {
  perCalendar: 250,
  total: 500,
  /** The longest window the screen asks for: six weeks and a day. */
  windowDays: 43,
} as const;
