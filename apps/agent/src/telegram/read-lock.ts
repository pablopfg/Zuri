import { TELEGRAM_LIMITS } from "@zuri/shared";
import type { InternalState } from "../db/internal-state.ts";
import type { PrivateLink, TelegramLinks } from "./links.ts";

const HOUR_MS = 3_600_000;

/**
 * The bot's read lock (spec, "Trava de leitura do bot"; N10). Whoever takes
 * the owner's Telegram account must not read everything: after the configured
 * hours without use (1 to 72, 12 by default), the conversation and the
 * commands that show the owner's content ask to be unlocked, by a passkey or
 * an e-mailed code (TelegramConfirmations).
 *
 * Use is counted only while unlocked: a message sent while locked (even /ajuda)
 * never moves `last_used_at`, so writing to the bot can't open it. An unlock
 * opens reading for 12 hours whatever the idle time, and counts as use.
 */
export class ReadLock {
  constructor(
    private readonly links: TelegramLinks,
    private readonly state: InternalState,
    private readonly clock: () => number = Date.now,
  ) {}

  /** The hours without use that lock reading, as set in the app (the default when the stored value is off). */
  hours(): number {
    const stored = this.state.get<unknown>("bot_read_lock_hours");
    const { min, max } = TELEGRAM_LIMITS.readLockHours;
    return typeof stored === "number" && Number.isInteger(stored) && stored >= min && stored <= max ? stored : TELEGRAM_LIMITS.readLockHours.default;
  }

  /** Until when the last unlock keeps reading open (ms), or null. */
  unlockedUntil(): number | null {
    const stored = this.state.get<unknown>("bot_unlocked_until");
    const at = typeof stored === "string" ? Date.parse(stored) : Number.NaN;
    return Number.isFinite(at) && at > this.clock() ? at : null;
  }

  /**
   * Whether the link's reading is locked now: no unlock still running and more
   * than the lock's hours since the last use (the confirmation, for a link
   * never used). Exactly the hours is still open.
   */
  locked(link: PrivateLink): boolean {
    if (this.unlockedUntil() !== null) return false;
    const since = Date.parse(link.lastUsedAt ?? link.confirmedAt ?? link.linkedAt);
    // A broken date fails closed.
    if (!Number.isFinite(since)) return true;
    return this.clock() - since > this.hours() * HOUR_MS;
  }

  /** Until when reading stays open with no more use (ms): the later of the unlock's end and the last use plus the hours. */
  openUntil(link: PrivateLink): number {
    const since = Date.parse(link.lastUsedAt ?? link.confirmedAt ?? link.linkedAt);
    const byUse = Number.isFinite(since) ? since + this.hours() * HOUR_MS : this.clock();
    return Math.max(byUse, this.unlockedUntil() ?? 0);
  }

  /** The owner confirmed: reading opens for 12 hours from now, and this counts as use. Returns until when (ISO). */
  unlock(): string {
    const until = new Date(this.clock() + TELEGRAM_LIMITS.unlockMs).toISOString();
    this.state.set("bot_unlocked_until", until);
    this.links.touch();
    return until;
  }
}
