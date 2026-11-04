import { REVIEW_LIMITS } from "@zuri/shared";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "../src/http/errors.ts";
import { add, consent, draftAnswer, later, LOCATION, PATTERN, row, SECOND_OK, turnOn, withReviewsWorld, type ReviewsWorld } from "./reviews-world.ts";

// Step 19c, the edges: replies made or removed at Google after a review was
// read, Google's odd answers, failures of each kind, and what the owner may
// no longer do once a review moved on.

const HOUR = 3_600_000;
const SIGNED = "Obrigado pela visita, Ana! Ficamos muito felizes com a sua avaliação.\n\nEquipe Exemplo";

async function code(work: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof work === "function" ? work() : work);
  } catch (error) {
    if (error instanceof AppError) return `${error.code}:${error.messageKey}`;
    throw error;
  }
  return "ok";
}

const at = (world: ReviewsWorld) => new Date(world.clock.now).toISOString();
const reply = (world: ReviewsWorld, id: string, comment: string | undefined) =>
  world.sim.business.edit(LOCATION, id, { reviewReply: comment === undefined ? undefined : { comment, updateTime: at(world) } });

/** Moves the watermark more than an hour past `id`: the next checks see it only as an older review. */
async function bury(world: ReviewsWorld) {
  world.clock.now += 2 * HOUR;
  add(world, `z${world.clock.now}`, 4);
  await later(world, 1);
}

describe("replies made elsewhere", () => {
  it("sees a reply made at Google to a review already read, and the review waiting again when it goes", () =>
    withReviewsWorld(async (world) => {
      await turnOn(world, "off");
      add(world, "a", 1, "Ruim");
      add(world, "h", 5);
      await later(world);
      // Within the hour: read again with its page.
      reply(world, "a", "Sentimos muito. Equipe");
      await later(world);
      expect(row(world, "a")).toMatchObject({ state: "replied_elsewhere", reply: "Sentimos muito. Equipe" });
      await bury(world);
      // Older than the watermark: only its reply is looked at.
      reply(world, "a", undefined);
      await later(world);
      expect(row(world, "a")).toMatchObject({ state: "escalated", reply: null });
      reply(world, "a", "De novo. Equipe");
      await later(world);
      expect(row(world, "a")?.state).toBe("replied_elsewhere");
      // A positive one waits as new when its reply goes.
      reply(world, "h", "Valeu. Equipe");
      await later(world);
      reply(world, "h", undefined);
      await later(world);
      expect(row(world, "h")?.state).toBe("new");
    }));

  it("keeps a history review history when someone answers it", () =>
    withReviewsWorld(async (world) => {
      add(world, "old", 1, "Ruim");
      await turnOn(world);
      reply(world, "old", "Resposta. Equipe");
      await later(world);
      expect(row(world, "old")).toMatchObject({ state: "history", reply: "Resposta. Equipe" });
    }));

  it("tells the team when an answered review drops to 3 stars or fewer, and keeps the reply", () =>
    withReviewsWorld(async (world) => {
      await turnOn(world);
      add(world, "a", 5, undefined, { reply: "Valeu! Equipe" });
      await later(world);
      world.sim.business.edit(LOCATION, "a", { starRating: "TWO", comment: "Piorou", updateTime: new Date(world.clock.now + 1000).toISOString() });
      await later(world);
      expect(row(world, "a")).toMatchObject({ state: "replied_elsewhere", rating: 2, reply: "Valeu! Equipe" });
      expect(world.notices).toEqual([{ kind: "reviews.worse", rating: 2, firstName: "Ana", comment: "Piorou" }]);
    }));

  it("a review edited with its reply removed waits again, triaged by its new rating", () =>
    withReviewsWorld(async (world) => {
      await turnOn(world, "off");
      add(world, "a", 5, undefined, { reply: "Valeu! Equipe" });
      await later(world);
      world.sim.business.edit(LOCATION, "a", { starRating: "ONE", comment: "Ruim", reviewReply: undefined, updateTime: new Date(world.clock.now + 1000).toISOString() });
      await later(world);
      expect(row(world, "a")).toMatchObject({ state: "escalated", rating: 1, reply: null });
    }));
});

describe("Google's odd answers and failures", () => {
  it("lists only well-formed profiles, names the untitled, and drops one Google no longer lists", () =>
    withReviewsWorld(async (world) => {
      world.sim.business.accounts.push({ name: "bad name", accountName: "x" }, { name: "accounts/102", accountName: "Outra" });
      world.sim.business.locations.set("accounts/102", [{ name: "locations/301", title: "" }, { name: 7 as never, title: "x" }, { name: "lugar/1", title: "y" }]);
      await consent(world, "calendar");
      await consent(world, "reviews");
      const listed = await world.reviews.listLocations();
      expect(listed.map((item) => [item.id, item.title])).toEqual([
        ["accounts/102/locations/301", "301"],
        ["accounts/101/locations/201", "Exemplo Centro"],
        ["accounts/101/locations/202", "Exemplo Filial"],
      ]);
      world.sim.business.locations.set("accounts/102", []);
      // Within a minute the copy answers (Google's quota is shared with the checks); after it, Google again.
      const business = vi.spyOn(world.google, "business");
      expect((await world.reviews.listLocations()).map((item) => item.id)).toContain("accounts/102/locations/301");
      expect(business).not.toHaveBeenCalled();
      world.clock.now += 60_000;
      expect((await world.reviews.listLocations()).map((item) => item.id)).not.toContain("accounts/102/locations/301");
    }));

  it("refuses to list profiles before Google allows it", () =>
    withReviewsWorld(async (world) => {
      await expect(world.reviews.listLocations()).rejects.toMatchObject({ kind: "not_connected" });
    }));

  it.each([
    ["the Business Profile API off", { status: 403, body: { error: { code: 403, details: [{ reason: "SERVICE_DISABLED" }] } } }, "api_disabled"],
    ["a quota of zero (no Basic API Access yet)", { status: 429, body: { error: { code: 429, details: [{ metadata: { quota_limit_value: "0" } }] } } }, "no_access"],
    ["a missing scope", { status: 403, body: { error: { code: 403, details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } } }, "no_access"],
  ])("explains %s on the screen and waits 6 hours", (_label, failure, problem) =>
    withReviewsWorld(async (world) => {
      await turnOn(world);
      world.sim.business.failure = failure;
      expect(await later(world)).toBe("failed");
      expect(world.reviews.status().problem).toBe(problem);
      expect(world.reviews.nextDue()).toBe(world.clock.now + 6 * HOUR);
      // Told once a day, not at every check.
      world.clock.now += 6 * HOUR;
      await world.reviews.check("alarm");
      expect(world.notices.filter((n) => n.kind === "reviews.problem")).toHaveLength(1);
    }));

  it("backs off on a busy Google, never past 6 hours", () =>
    withReviewsWorld(async (world) => {
      await turnOn(world);
      world.sim.business.failure = { status: 429, body: { error: { code: 429 } } };
      const waits: number[] = [];
      for (let i = 0; i < 7; i++) {
        world.clock.now = (world.reviews.nextDue() ?? world.clock.now) + 1;
        await world.reviews.check("alarm");
        waits.push(((world.reviews.nextDue() ?? 0) - world.clock.now) / 60_000);
      }
      expect(waits).toEqual([15, 30, 60, 120, 240, 360, 360]);
    }));

  it("tries again in a minute when the wake's subrequests run out, and in an hour when Google is disconnected", () =>
    withReviewsWorld(async (world) => {
      await turnOn(world);
      world.clock.now += 16 * 60_000;
      const { GoogleMeter } = await import("../src/google/service.ts");
      expect(await world.reviews.check("alarm", new GoogleMeter(0))).toBe("partial");
      expect(world.reviews.nextDue()).toBe(world.clock.now + 60_000);
      // The access taken back at Google: the next token renewal fails.
      world.sim.refreshTokens.clear();
      world.sim.accessTokens.clear();
      world.clock.now += 2 * HOUR;
      expect(await world.reviews.check("alarm")).toBe("failed");
      // No wakes while Google is out of reach; the screen asks to connect again.
      expect(world.reviews.nextDue()).toBeNull();
      expect(world.db.one(`SELECT next_check FROM zur_review_settings`)).toEqual({ next_check: world.clock.now + HOUR });
      expect(world.reviews.status().problem).toBe("reconnect");
    }));

  it("skips a page Google sends out of shape", () =>
    withReviewsWorld(async (world) => {
      await turnOn(world);
      world.sim.business.reviews.get(LOCATION)?.push({ name: `${LOCATION}/reviews/bad`, reviewId: "bad", starRating: "FIVE", createTime: "ontem", updateTime: "ontem" });
      expect(await later(world)).toBe("ok");
      expect(world.db.all(`SELECT id FROM zur_reviews`)).toEqual([]);
    }));

  it("stops a check the owner turned off midway", () =>
    withReviewsWorld(async (world) => {
      await turnOn(world);
      add(world, "a", 1, "Ruim");
      world.clock.now += 16 * 60_000;
      const running = world.reviews.check("alarm");
      world.reviews.disable();
      expect(await running).toBe("off");
      expect(world.notices).toEqual([]);
    }));
});

describe("drafts at the edges", () => {
  it("escalates a review the AI calls suspicious or in another language, without a draft for the suspicious one", () =>
    withReviewsWorld(async (world) => {
      await turnOn(world);
      add(world, "s", 5, "Adorei o atendimento, todos muito gentis.");
      add(world, "l", 5, "Muy bueno el lugar, gracias.");
      world.answers.push(draftAnswer(SIGNED, { sentiment: "suspicious" }), draftAnswer(SIGNED, { language: "other" }));
      world.answers.push(draftAnswer("Sentimos muito pela experiência. Fale com a gente pelo canal oficial."), SECOND_OK);
      await later(world);
      const reasons = [row(world, "s"), row(world, "l")].map((r) => JSON.parse(r?.reasons ?? "[]")[0]).sort();
      expect(reasons).toEqual(["language", "suspicious"]);
      expect(row(world, "s")?.state).toBe("escalated");
    }));

  it("leaves a review without a draft when the templates are gone", () =>
    withReviewsWorld(async (world) => {
      await turnOn(world);
      world.db.run(`UPDATE zur_review_settings SET templates = 'não é json'`);
      add(world, "a", 5);
      await later(world);
      expect(row(world, "a")).toMatchObject({ state: "new", needs_draft: 0, draft: null });
      expect(world.reviews.status().pattern.templates).toEqual([]);
    }));

  it("refuses to write again what moved on, and in a lockdown", () =>
    withReviewsWorld(async (world) => {
      await turnOn(world);
      add(world, "a", 5, undefined, { reply: "Valeu! Equipe" });
      add(world, "b", 5);
      await later(world);
      expect(await code(world.reviews.redraft(crypto.randomUUID()))).toBe("NOT_FOUND:error.reviewNotFound");
      expect(await code(world.reviews.redraft(row(world, "a")?.id as string))).toBe("CONFLICT:error.reviewHandled");
      world.lockdown.active = true;
      expect(await code(world.reviews.redraft(row(world, "b")?.id as string))).toBe("LOCKDOWN_ACTIVE:auth.lockdown.active");
    }));
});

describe("publishing at the edges", () => {
  async function proposed(world: ReviewsWorld) {
    add(world, "p", 5);
    await later(world);
    return world.reviews.item(row(world, "p") as never);
  }

  it("does not publish when Google's copy can't be read, and keeps the proposal", () =>
    withReviewsWorld(async (world) => {
      await turnOn(world);
      const item = await proposed(world);
      world.sim.business.edit(LOCATION, "p", { name: `${LOCATION}/reviews/outra` });
      await expect(world.reviews.approve(item.id, { text: item.draft as string, version: item.version }, "app")).rejects.toMatchObject({ kind: "unavailable" });
      expect(row(world, "p")?.state).toBe("proposed");
    }));

  it("settles an uncertain publication answered by someone else, or removed", () =>
    withReviewsWorld(async (world) => {
      await turnOn(world);
      const item = await proposed(world);
      world.sim.business.replyFailure = "throw";
      expect(await code(world.reviews.approve(item.id, { text: item.draft as string, version: item.version }, "app"))).toBe("SERVICE_UNAVAILABLE:error.reviewUncertain");
      world.sim.business.replyFailure = null;
      reply(world, "p", "Outra pessoa respondeu. Equipe");
      await later(world);
      expect(row(world, "p")?.state).toBe("replied_elsewhere");
      world.db.run(`UPDATE zur_reviews SET state = 'uncertain'`);
      world.sim.business.reviews.set(LOCATION, []);
      await later(world);
      expect(row(world, "p")?.state).toBe("removed");
    }));

  it("leaves an uncertain one for later when Google fails again", () =>
    withReviewsWorld(async (world) => {
      await turnOn(world);
      await proposed(world);
      world.db.run(`UPDATE zur_reviews SET state = 'uncertain'`);
      world.sim.business.failure = { status: 503, body: {} };
      expect(await later(world)).toBe("failed");
      expect(row(world, "p")?.state).toBe("uncertain");
    }));

  it("deletes a reply only after reading it again: gone, changed by someone, the review removed, or a lockdown", () =>
    withReviewsWorld(async (world) => {
      await turnOn(world);
      const item = await proposed(world);
      await world.reviews.approve(item.id, { text: item.draft as string, version: item.version }, "app");
      world.lockdown.active = true;
      expect(await code(world.reviews.deleteReply(item.id, "app"))).toBe("LOCKDOWN_ACTIVE:auth.lockdown.active");
      world.lockdown.active = false;
      expect(await code(world.reviews.deleteReply(crypto.randomUUID(), "app"))).toBe("NOT_FOUND:error.reviewNotFound");
      // Changed at Google by someone: theirs now.
      reply(world, "p", "Mudei a resposta. Equipe");
      expect(await code(world.reviews.deleteReply(item.id, "app"))).toBe("CONFLICT:error.reviewNotMine");
      expect(row(world, "p")?.state).toBe("replied_elsewhere");
      // Already gone at Google: nothing to delete, the review waits again.
      world.db.run(`UPDATE zur_reviews SET state = 'replied', reply_hash = 'x'`);
      reply(world, "p", undefined);
      expect((await world.reviews.deleteReply(item.id, "app")).state).toBe("new");
      world.db.run(`UPDATE zur_reviews SET state = 'replied', reply_hash = 'x'`);
      world.sim.business.reviews.set(LOCATION, []);
      expect(await code(world.reviews.deleteReply(item.id, "app"))).toBe("CONFLICT:error.reviewRemoved");
      world.db.run(`UPDATE zur_reviews SET state = 'replied', reply_hash = 'x'`);
      world.sim.business.failure = { status: 503, body: {} };
      await expect(world.reviews.deleteReply(item.id, "app")).rejects.toMatchObject({ kind: "unavailable" });
    }));

  it("keeps the audit for 180 days", () =>
    withReviewsWorld(async (world) => {
      await turnOn(world);
      const item = await proposed(world);
      world.clock.now += REVIEW_LIMITS.eventsDays * 86_400_000 + 1;
      await world.reviews.discard(item.id, "app");
      // The old ones go at the next check, once per check rather than on every event.
      await world.reviews.check("alarm");
      expect(world.db.all<{ action: string }>(`SELECT action FROM zur_review_events`).map((e) => e.action)).toEqual(["discarded"]);
    }));

  it("is off with a reconnect problem once Google takes the access back", () =>
    withReviewsWorld(async (world) => {
      await turnOn(world);
      expect(PATTERN.templates).toHaveLength(3);
      world.db.run(`UPDATE zur_google_account SET scopes = ''`);
      expect(world.reviews.status()).toMatchObject({ enabled: true, granted: false, problem: "reconnect", locations: [] });
      expect(await world.reviews.check("alarm")).toBe("off");
    }));
});
