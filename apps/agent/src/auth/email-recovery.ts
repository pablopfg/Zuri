import { hmacSha256Hex, RECOVERY_LIMITS, randomToken, timingSafeEqualText } from "@zuri/shared";
import type { InternalState } from "../db/internal-state.ts";

interface StoredLink {
  /** HMAC of the token: the database never holds a link that works. */
  hash: string;
  expiresAt: number;
  /** Wrong second-step codes given with this link. */
  wrong: number;
}

/**
 * The password recovery link (step 11c): one at a time, 30 minutes, used once.
 * A new request replaces the link before it. Requests are limited per network
 * (3 in 15 minutes), whether or not the e-mail typed is the owner's, so the
 * answer never tells which.
 */
export class RecoveryLinks {
  constructor(
    private readonly state: InternalState,
    private readonly secret: string,
    private readonly clock: () => number,
  ) {}

  private hash(token: string): Promise<string> {
    return hmacSha256Hex(this.secret, `zuri:recovery:v1:${token}`);
  }

  /** Takes this network's place for a request, or answers how long to wait (seconds). */
  reserve(network: string): number | null {
    const now = this.clock();
    const since = now - RECOVERY_LIMITS.windowMs;
    let stored: Record<string, number[]> = {};
    try {
      const raw = this.state.get<string>("recovery_requests");
      if (typeof raw === "string") stored = JSON.parse(raw) as Record<string, number[]>;
    } catch {
      stored = {};
    }
    const live = Object.entries(stored)
      .map(([key, times]) => [key, Array.isArray(times) ? times.filter((at) => typeof at === "number" && at > since) : []] as const)
      .filter(([, times]) => times.length > 0);
    const mine = live.find(([key]) => key === network)?.[1] ?? [];
    if (mine.length >= RECOVERY_LIMITS.perNetwork) return Math.max(1, Math.ceil(((mine[0] ?? now) + RECOVERY_LIMITS.windowMs - now) / 1000));
    // The networks seen longest ago go first: a flood from many addresses can't grow the row.
    const others = live.filter(([key]) => key !== network).sort((a, b) => (b[1].at(-1) ?? 0) - (a[1].at(-1) ?? 0));
    const kept = Object.fromEntries([[network, [...mine, now]], ...others.slice(0, RECOVERY_LIMITS.networksKept - 1)]);
    this.state.set("recovery_requests", JSON.stringify(kept));
    return null;
  }

  /** A new link; the one before stops working. */
  async issue(): Promise<{ token: string; expiresAt: number }> {
    const token = randomToken(32);
    const expiresAt = this.clock() + RECOVERY_LIMITS.ttlMs;
    const stored: StoredLink = { hash: await this.hash(token), expiresAt, wrong: 0 };
    this.state.set("recovery_link", JSON.stringify(stored));
    return { token, expiresAt };
  }

  private stored(): StoredLink | null {
    try {
      const raw = this.state.get<string>("recovery_link");
      const parsed = typeof raw === "string" ? (JSON.parse(raw) as StoredLink) : null;
      return parsed && typeof parsed.hash === "string" && typeof parsed.expiresAt === "number" ? parsed : null;
    } catch {
      return null;
    }
  }

  /** Whether this token is the live link (right, not expired, not used). The comparison takes the same time however much matched. */
  async valid(token: string): Promise<boolean> {
    // Hashed first, read after: nothing can change the stored link between this read and the caller's next step.
    const given = await this.hash(token);
    const stored = this.stored();
    if (!stored || stored.expiresAt <= this.clock()) return false;
    return timingSafeEqualText(given, stored.hash);
  }

  /** A wrong code given with the link; the fifth ends it. Returns the tries left. */
  wrongCode(): number {
    const stored = this.stored();
    if (!stored) return 0;
    const wrong = stored.wrong + 1;
    if (wrong >= RECOVERY_LIMITS.codeTries) {
      this.clear();
      return 0;
    }
    this.state.set("recovery_link", JSON.stringify({ ...stored, wrong }));
    return RECOVERY_LIMITS.codeTries - wrong;
  }

  /** Used, or every session ended for another reason: the link goes. */
  clear(): void {
    this.state.delete("recovery_link");
  }
}
