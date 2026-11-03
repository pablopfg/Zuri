/**
 * Google Contacts (step 19b): a read-only copy of the contacts in the labels
 * the owner picks, on the same Google connection as the calendar (step 19).
 * Google stays the source of truth; Zuri never changes a contact there and
 * never writes to anyone in the copy. The interface uses only the types and
 * constants here; the schemas run on the server (rule P11).
 */

/** Read only, joined to the calendar's grant with `include_granted_scopes`. */
export const CONTACTS_SCOPE = "https://www.googleapis.com/auth/contacts.readonly";

export const CONTACT_LIMITS = {
  /** Contacts copied at most; past it the sync stops and asks for fewer labels. */
  maxContacts: 5_000,
  /** The owner's labels read from Google; the rest is left out. */
  maxLabels: 200,
  /** Pages of 1,000 read per wake (10,000 contacts at Google): a large account ends on the next wake. */
  pagesPerWake: 10,
  pageSize: 1_000,
  phones: 5,
  emails: 5,
  dates: 5,
  fields: 20,
  fieldKey: 200,
  fieldValue: 200,
  notes: 2_000,
  name: 200,
  labelName: 120,
  organization: 200,
  /** "Contact added to a label" notices per sync; the first full read sends none. */
  addedPerSync: 20,
  /** Names listed in one birthday or special date notice; the rest is a count. */
  namesPerNotice: 20,
  /** Results of one search on the screen, and of search_contacts. */
  screenPage: 50,
  toolResults: 10,
  queryMax: 100,
  /** Days ahead the special dates notice may look. */
  daysAheadMax: 30,
  /** Label names a special date's label filter may hold. */
  matchMax: 60,
} as const;

/** off: never turned on (or turned off). syncing: reading Google now or soon. */
export const CONTACT_SYNC_STATUSES = ["off", "syncing", "ok", "error"] as const;
export type ContactSyncStatus = (typeof CONTACT_SYNC_STATUSES)[number];

/**
 * Why the sync stopped and needs the owner: the access is gone (reconnect), the
 * People API is off in the owner's Google Cloud project, the contacts scope was
 * not granted, the labels hold more than the ceiling, or Google keeps failing.
 */
export const CONTACT_PROBLEMS = ["reconnect", "api_disabled", "scope", "too_many", "unavailable"] as const;
export type ContactProblem = (typeof CONTACT_PROBLEMS)[number];

/** What a contact who joins a chosen label brings: nothing, a notice, or a notice and a task for tomorrow. */
export const CONTACT_ON_ADDED = ["off", "notice", "task"] as const;
export type ContactOnAdded = (typeof CONTACT_ON_ADDED)[number];

export interface ContactLabel {
  /** Google's resource name ("contactGroups/abc"). */
  id: string;
  name: string;
  /** Contacts Google counts in it. */
  count: number;
  selected: boolean;
}

export interface ContactReminders {
  birthdays: boolean;
  dates: boolean;
  /** "HH:MM" in the owner's time zone. */
  time: string;
  /** The special dates notice looks this many days ahead (0 = today). */
  daysAhead: number;
  /** Only dates whose label holds this text ("Retorno"); empty: all of them. */
  match: string;
}

export interface ContactsStatus {
  /** The Google account is connected (step 19): contacts can be turned on. */
  connected: boolean;
  enabled: boolean;
  status: ContactSyncStatus;
  problem: ContactProblem | null;
  /** UTC ISO of the last sync that ended well. */
  lastSyncAt: string | null;
  contacts: number;
  labels: ContactLabel[];
  reminders: ContactReminders;
  onAdded: ContactOnAdded;
}

export interface ContactSummary {
  id: string;
  name: string;
  /** Names of the contact's labels. */
  labels: string[];
  phone: string | null;
  email: string | null;
  /** "MM-DD" */
  birthday: string | null;
}

export interface ContactValue {
  label: string;
  value: string;
}

export interface ContactDate {
  label: string;
  /** "MM-DD", or "YYYY-MM-DD" with the year. */
  date: string;
}

export interface ContactDetail extends ContactSummary {
  nickname: string;
  phones: ContactValue[];
  emails: ContactValue[];
  /** "MM-DD" or "YYYY-MM-DD". */
  birthdayFull: string | null;
  dates: ContactDate[];
  organization: string;
  jobTitle: string;
  notes: string;
  fields: ContactValue[];
  /** The contact in Google Contacts. */
  googleUrl: string;
}

/** GET /api/contacts */
export interface ContactPage {
  contacts: ContactSummary[];
  /** More results: ask again with `after` = this cursor. */
  next: string | null;
}
