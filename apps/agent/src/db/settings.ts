import {
  DEFAULT_SETTINGS,
  isTimeZone,
  type Locale,
  type Settings,
  type SettingsUpdate,
  settingsSchema,
  settingsUpdateSchema,
} from "@zuri/shared";
import { AppError } from "../http/errors.ts";
import { recordActivity } from "./activity.ts";
import { type Database, now } from "./database.ts";

/** Where each setting lives in zur_settings. The column holds data, never translated text. */
const STORAGE_KEYS = {
  language: "language",
  timeZone: "time_zone",
} as const satisfies Record<keyof Settings, string>;

type Field = keyof Settings;
const FIELDS = Object.keys(STORAGE_KEYS) as Field[];

/**
 * The owner's settings: defaults until changed, one row per changed field.
 * A stored value that no longer validates (a hand-edited row, a value an older
 * version allowed) reads as the default instead of breaking every request.
 */
export class SettingsRepository {
  readonly #defaults: Settings;

  /**
   * `installDefaults` comes from the Worker's variables (DEFAULT_TIMEZONE). An
   * invalid one is ignored, so a typo in the deploy never breaks dates.
   */
  constructor(
    private readonly db: Database,
    installDefaults: { timeZone?: string | undefined } = {},
  ) {
    const timeZone = installDefaults.timeZone?.trim();
    this.#defaults = { ...DEFAULT_SETTINGS, ...(timeZone && isTimeZone(timeZone) ? { timeZone } : {}) };
  }

  get(): Settings {
    const settings: Record<string, unknown> = { ...this.#defaults };
    for (const field of FIELDS) {
      const stored = this.read(STORAGE_KEYS[field]);
      if (stored === undefined) continue;
      const valid = settingsSchema.shape[field].safeParse(stored);
      if (valid.success) settings[field] = valid.data;
    }
    return settings as Settings;
  }

  /** The language of the text the server writes on its own (API errors, bot, e-mail). */
  locale(): Locale {
    return this.get().language;
  }

  /** Validates and saves a change; only fields that really changed are written and logged. */
  update(patch: SettingsUpdate): Settings {
    const parsed = settingsUpdateSchema.safeParse(patch);
    if (!parsed.success) {
      // Only the paths of the problems go back: never the values sent.
      const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "_"))];
      throw new AppError("VALIDATION_FAILED", undefined, { fields });
    }
    const current = this.get();
    const changed = FIELDS.filter((field) => parsed.data[field] !== undefined && parsed.data[field] !== current[field]);
    if (changed.length === 0) return current;
    this.db.transaction(() => {
      const at = now();
      for (const field of changed) {
        this.db.run(
          `INSERT INTO zur_settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          STORAGE_KEYS[field],
          JSON.stringify(parsed.data[field]),
          at,
        );
      }
      recordActivity(this.db, "settings.updated", { fields: changed });
    });
    return this.get();
  }

  private read(key: string): unknown {
    const row = this.db.one<{ value: string }>(`SELECT value FROM zur_settings WHERE key = ?`, key);
    if (!row) return undefined;
    try {
      return JSON.parse(row.value);
    } catch {
      return undefined;
    }
  }
}
