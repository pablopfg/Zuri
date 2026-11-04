/**
 * Google reviews (step 19c): the reviews of the owner's business profile on
 * Google, read every 15 minutes on the same Google connection as the calendar
 * (step 19). A fixed rule on the rating decides first (the AI can only make a
 * review more cautious), negative ones go to the team, and nothing is
 * published without the owner's approval. Replying is the first public
 * message Zuri writes to someone else: docs/planos/google-business-profile.md.
 * The interface uses only the types and constants here; the schemas run on
 * the server (rule P11).
 */

/** The Business Profile scope, joined to the calendar's grant with `include_granted_scopes`. */
export const BUSINESS_SCOPE = "https://www.googleapis.com/auth/business.manage";

export const REVIEW_LIMITS = {
  /** How often the alarm reads the reviews. */
  checkEveryMs: 15 * 60_000,
  /** "Check now" at most once a minute. */
  checkNowEveryMs: 60_000,
  /** Pages of 50 read per check; the rest waits for the next one, from where this one stopped. */
  pagesPerCheck: 3,
  pageSize: 50,
  /** Older than this when first read: history, never a notice nor a draft. */
  maxAgeDays: 14,
  /** Locations (profiles) the owner may pick, and listed from Google. */
  maxLocations: 3,
  listedLocations: 20,
  /** A comment longer than this is never read by the AI: the team gets it as suspicious. */
  commentForAi: 2_000,
  /** What Zuri keeps of a comment and a reply. */
  commentMax: 4_096,
  replyMin: 40,
  replyMax: 600,
  replyBytes: 4_096,
  signatureMin: 2,
  signatureMax: 60,
  templatesMin: 3,
  templatesMax: 5,
  templateMin: 20,
  templateMax: 600,
  bannedMax: 50,
  bannedWordMax: 40,
  firstNameMax: 20,
  /** Drafts written by the AI a day; past it a positive gets a template and a negative none. */
  aiDraftsPerDay: 30,
  /** Neurons the module may spend a day, within the owner's 9,000. */
  neuronsPerDay: 1_000,
  /** AI drafts per wake: the rest waits for the next one (each draft is two model calls). */
  draftsPerWake: 3,
  /** Publications per wake. */
  publishesPerWake: 3,
  /** A proposal waits this long for the owner. */
  proposalTtlMs: 72 * 3_600_000,
  /** A burst: this many negative or new reviews in an hour sends one grouped notice. */
  burstNegative: 5,
  burstNew: 10,
  burstWindowMs: 3_600_000,
  /** Single notices per check; more become one grouped notice. */
  noticesPerCheck: 3,
  /** A negative review left without an answer is told again once, after this long. */
  insistAfterMs: 48 * 3_600_000,
  /** Reviews per page of the screen. */
  screenPage: 30,
  /** Audit rows are kept this long. */
  eventsDays: 180,
} as const;

/** Off: only the notices to the team (nothing drafted for approval). Approve: every reply waits for the owner. */
export const REVIEW_LEVELS = ["off", "approve"] as const;
export type ReviewLevel = (typeof REVIEW_LEVELS)[number];

export const REVIEW_TONES = ["close", "formal"] as const;
export type ReviewTone = (typeof REVIEW_TONES)[number];

/**
 * Where a review stands. history: before the module or too old; new: waits for
 * its draft; escalated: with the team (a careful draft may come); proposed: a
 * reply waits for the owner; sending/uncertain: going out, or no answer from
 * Google; replied: by Zuri; replied_elsewhere: someone answered on Google;
 * resolved: the owner handled it outside Zuri; removed: deleted at Google.
 */
export const REVIEW_STATES = ["history", "new", "escalated", "proposed", "sending", "uncertain", "replied", "replied_elsewhere", "resolved", "removed"] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

/** Why a review went to the team. */
export const REVIEW_REASONS = ["low_rating", "complaint", "suspicious", "health", "language", "worse"] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];

/** Who wrote the draft: the AI, one of the owner's templates, or the owner. */
export const REVIEW_DRAFT_SOURCES = ["ai", "template", "owner"] as const;
export type ReviewDraftSource = (typeof REVIEW_DRAFT_SOURCES)[number];

/**
 * Codes of the fixed checker of a reply (never the text): size, language,
 * contact or digit, markup, a name, copied words, a banned word, the
 * signature, hidden characters; and the AI's second reading.
 */
export const REVIEW_GUARD_CODES = ["size", "language", "contact", "markup", "name", "copied", "banned", "signature", "hidden", "second_read", "invalid"] as const;
export type ReviewGuardCode = (typeof REVIEW_GUARD_CODES)[number];

/** Why the module needs the owner. */
export const REVIEW_PROBLEMS = ["reconnect", "no_access", "api_disabled", "unavailable"] as const;
export type ReviewProblem = (typeof REVIEW_PROBLEMS)[number];

export const REVIEW_TABS = ["needs", "answered", "all"] as const;
export type ReviewTab = (typeof REVIEW_TABS)[number];

export interface ReviewLocation {
  /** Google's name of the location ("accounts/1/locations/2"). */
  id: string;
  title: string;
  selected: boolean;
}

export interface ReviewPattern {
  signature: string;
  tone: ReviewTone;
  templates: string[];
  banned: string[];
}

export interface ReviewsStatus {
  /** The Google account is connected (the calendar's connection). */
  connected: boolean;
  /** Google granted business.manage. */
  granted: boolean;
  enabled: boolean;
  level: ReviewLevel;
  paused: boolean;
  problem: ReviewProblem | null;
  lastCheckAt: string | null;
  locations: ReviewLocation[];
  pattern: ReviewPattern;
  /** Reviews waiting for the owner (the tab's number). */
  needs: number;
}

/** A review as the screen gets it: the first name only, never Google's ids or the photo. */
export interface ReviewItem {
  id: string;
  location: string;
  rating: number;
  firstName: string;
  anonymous: boolean;
  comment: string;
  createdAt: string;
  updatedAt: string;
  state: ReviewState;
  reasons: ReviewReason[];
  draft: string | null;
  draftSource: ReviewDraftSource | null;
  /** The draft fell back to a template: the AI's one failed these checks. */
  fallback: ReviewGuardCode[];
  /** The reply on Google, when there is one. */
  reply: string | null;
  /** The reply is Zuri's (only then can it be deleted here). */
  replyMine: boolean;
  /** Ties an approval to this version of the review. */
  version: string;
  /** When a proposal stops being approvable. */
  expiresAt: string | null;
}

export interface ReviewPage {
  items: ReviewItem[];
  nextCursor: string | null;
  counts: Record<ReviewTab, number>;
}
