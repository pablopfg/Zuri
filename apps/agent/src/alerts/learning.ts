import { type AlertCategory, type AlertPriority, LEARNING, type LearnedPriority } from "@zuri/shared";
import type { Database } from "../db/database.ts";

/** The levels a source can move between; critical never learns. */
const LEVELS = ["low", "normal", "high"] as const;

/** Categories that never learn: a reminder is something the owner asked for, and security is always critical. */
const FIXED: readonly AlertCategory[] = ["security", "reminders"];

/** Kinds that never learn either: the day's AI used up and a failure repeating must keep reaching the phone. */
const FIXED_KINDS: readonly string[] = ["watch.aiBudget100", "diagnostic.repeated", "watch.health"];

export interface LearningChange {
  key: string;
  label: string;
  /** The level the source's notices now get. */
  priority: AlertPriority;
  direction: "down" | "up";
}

interface SourceStats {
  key: string;
  total: number;
  ignored: number;
  quick: number;
  /** The priority the newest notice of the source asked for, before any shift. */
  asked: AlertPriority;
  label: string;
}

/**
 * The priority that learns (spec, step 11): each notice keeps its source (an
 * automation, or a kind of notice). Once a day the review looks at the last
 * 14 days of each source: when the owner ignored at least 80% of them (never
 * opened, or told it to stop insisting), it goes down a level; when they
 * opened 80% within 15 minutes, up a level, never past high. One level a week
 * at most. Critical notices, security and reminders never learn.
 */
export class AlertLearning {
  constructor(
    private readonly db: Database,
    private readonly deps: { enabled: () => boolean; sourceName: (kind: string) => string; clock?: () => number },
  ) {}

  private now(): number {
    return this.deps.clock?.() ?? Date.now();
  }

  /** The source's key, or null when it never learns. */
  keyOf(input: { kind: string; category: AlertCategory; priority: AlertPriority; source?: string | null | undefined }): string | null {
    if (FIXED.includes(input.category) || FIXED_KINDS.includes(input.kind) || input.priority === "critical" || input.source === null) return null;
    return input.source ?? input.kind;
  }

  /** The priority a notice of this source gets now: what it asks for, moved by what was learned. */
  adjust(key: string | null, priority: AlertPriority): AlertPriority {
    if (key === null || priority === "critical" || !this.deps.enabled()) return priority;
    const shift = this.db.one<{ shift: number }>(`SELECT shift FROM zur_alert_learning WHERE key = ?`, key)?.shift ?? 0;
    if (shift === 0) return priority;
    const at = LEVELS.indexOf(priority as (typeof LEVELS)[number]);
    return LEVELS[Math.max(0, Math.min(LEVELS.length - 1, at + shift))] ?? priority;
  }

  /** The sources that changed, for Settings > Notices. */
  list(): LearnedPriority[] {
    return this.db
      .all<{ key: string; label: string; shift: number; changed_at: string }>(`SELECT key, label, shift, changed_at FROM zur_alert_learning WHERE shift != 0 ORDER BY changed_at DESC`)
      // A kind of notice is named now, in the owner's language of today; an automation keeps its name.
      .map((row) => ({ key: row.key, label: row.key.startsWith("automation:") ? row.label : this.deps.sourceName(row.key), shift: row.shift, changedAt: row.changed_at }));
  }

  /** Back to what the source asks for. Nothing changes it again for a week: the owner just said so. */
  reset(key: string): boolean {
    const at = new Date(this.now()).toISOString();
    return this.db.run(`UPDATE zur_alert_learning SET shift = 0, changed_at = ? WHERE key = ? AND shift != 0`, at, key).rowsWritten > 0;
  }

  /** Runs the review when a day has passed since the last one; returns what changed. */
  review(lastReviewAt: number | null): LearningChange[] | null {
    const nowMs = this.now();
    if (!this.deps.enabled() || (lastReviewAt !== null && nowMs - lastReviewAt < LEARNING.reviewEveryMs)) return null;
    const from = new Date(nowMs - LEARNING.windowMs).toISOString();
    const to = new Date(nowMs - LEARNING.settleMs).toISOString();
    const quickDays = LEARNING.quickMs / 86_400_000;
    const sources = this.db.all<SourceStats>(
      `SELECT learn_key AS key,
              count(*) AS total,
              sum(CASE WHEN read_at IS NULL OR escalation = 'muted' THEN 1 ELSE 0 END) AS ignored,
              sum(CASE WHEN read_at IS NOT NULL AND coalesce(escalation, '') != 'muted' AND julianday(read_at) - julianday(created_at) <= ? THEN 1 ELSE 0 END) AS quick,
              (SELECT coalesce(n.asked_priority, n.priority) FROM zur_notices n WHERE n.learn_key = zur_notices.learn_key ORDER BY n.created_at DESC LIMIT 1) AS asked,
              (SELECT n.params FROM zur_notices n WHERE n.learn_key = zur_notices.learn_key ORDER BY n.created_at DESC LIMIT 1) AS label
         FROM zur_notices
        WHERE learn_key IS NOT NULL AND created_at >= ? AND created_at <= ?
        GROUP BY learn_key
       HAVING count(*) >= ?`,
      quickDays,
      from,
      to,
      LEARNING.minNotices,
    );
    const changes: LearningChange[] = [];
    const at = new Date(nowMs).toISOString();
    for (const source of sources) {
      const stored = this.db.one<{ shift: number; changed_at: string }>(`SELECT shift, changed_at FROM zur_alert_learning WHERE key = ?`, source.key);
      if (stored && Date.parse(stored.changed_at) > nowMs - LEARNING.changeEveryMs) continue;
      const asked = LEVELS.indexOf(source.asked as (typeof LEVELS)[number]);
      if (asked < 0) continue;
      // From the level notices get now (asked plus shift, within low..high), never from a stored
      // priority: the owner may have changed what the source asks for since.
      const level = Math.max(0, Math.min(LEVELS.length - 1, asked + (stored?.shift ?? 0)));
      let target = level;
      if (source.ignored >= source.total * LEARNING.ignoredShare && level > 0) target = level - 1;
      else if (source.quick >= source.total * LEARNING.quickShare && level < LEVELS.length - 1) target = level + 1;
      if (target === level) continue;
      const shift = target - asked;
      const label = (source.key.startsWith("automation:") ? labelOf(source.label) : "") || this.deps.sourceName(source.key);
      this.db.run(
        `INSERT INTO zur_alert_learning (key, shift, label, changed_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET shift = excluded.shift, label = excluded.label, changed_at = excluded.changed_at`,
        source.key,
        shift,
        label,
        at,
      );
      changes.push({ key: source.key, label, priority: LEVELS[target] ?? "normal", direction: target < level ? "down" : "up" });
    }
    // Sources that went back to zero long ago, past the cap: the oldest go (the table stays small).
    // A row changed this week stays: after an undo, it is what holds the source for a week.
    this.db.run(
      `DELETE FROM zur_alert_learning
        WHERE changed_at <= ?
          AND key IN (SELECT key FROM zur_alert_learning ORDER BY shift != 0 DESC, changed_at DESC LIMIT -1 OFFSET ?)`,
      new Date(nowMs - LEARNING.changeEveryMs).toISOString(),
      LEARNING.sourcesKept,
    );
    return changes;
  }
}

/** The source's name from its last notice's data: the automation's name, or nothing (the interface names the kind). */
function labelOf(params: string): string {
  try {
    const parsed = JSON.parse(params) as { name?: unknown };
    return typeof parsed.name === "string" ? [...parsed.name].slice(0, 80).join("") : "";
  } catch {
    return "";
  }
}
