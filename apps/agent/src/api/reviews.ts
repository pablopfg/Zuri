import { reviewApproveSchema, reviewSettingsSchema, reviewsQuerySchema } from "@zuri/shared";
import type { Context, Hono } from "hono";
import type { ClientInfo } from "../auth/client.ts";
import { toAppError } from "../google/errors.ts";
import { AppError } from "../http/errors.ts";
import type { ApiEnv } from "./app.ts";
import type { GoogleRouteDeps } from "./google.ts";
import { readJson } from "./http.ts";

/** A Google failure in the owner's words. */
async function owner<T>(work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw toAppError(error);
  }
}

const ID = /^[0-9a-f-]{36}$/;

function reviewId(c: Context<ApiEnv>): string {
  const id = c.req.param("id") ?? "";
  if (!ID.test(id)) throw new AppError("NOT_FOUND", "error.reviewNotFound");
  return id;
}

/**
 * Google reviews (step 19c): Settings › Integrations › Google › Reviews and
 * the Reviews tab of Contacts, after the session check (signed in, CSRF, the
 * owner's Origin). None of these is in WHILE_LOCKDOWN, no tool reaches them
 * and the bot has none: only the owner on the screen picks the profile, the
 * level or approves a reply. Answers never carry Google's ids of a review.
 */
export function registerReviewRoutes(app: Hono<ApiEnv>, deps: () => GoogleRouteDeps, _client: (c: Context<ApiEnv>) => ClientInfo): void {
  app.get("/reviews/status", () => Response.json(deps().reviews.status()));

  /** Google's page to add the Business Profile to the calendar's grant. */
  app.post("/reviews/connect", async (c) => {
    const { google, auth } = deps();
    auth.requireRecentAuth(c.get("session"));
    return Response.json({ url: await owner(() => google.begin(c.get("session").id, "reviews")) });
  });

  /** The profiles the account manages, read from Google now. */
  app.get("/reviews/locations", async () => Response.json({ locations: await owner(() => deps().reviews.listLocations()) }));

  /** The profile, the reply style and the level (the password typed recently, since replies go out in the owner's name), then a first read. */
  app.patch("/reviews/settings", async (c) => {
    const input = await readJson(c.req.raw, reviewSettingsSchema, 16 * 1024);
    const { reviews, auth } = deps();
    auth.requireRecentAuth(c.get("session"));
    reviews.configure(input);
    // The first read now (one page per newly picked profile, kept as history): the owner sees at once
    // whether Google lets Zuri in, instead of a minute later. Its failures land in the status.
    await reviews.firstRead();
    await deps().rearm();
    return Response.json(reviews.status());
  });

  /** Turns the reviews off and forgets their copy (Google keeps the originals). */
  app.delete("/reviews", async (c) => {
    const { reviews, auth } = deps();
    auth.requireRecentAuth(c.get("session"));
    reviews.disable();
    await deps().rearm();
    return Response.json(reviews.status());
  });

  app.post("/reviews/pause", () => {
    deps().reviews.pause(true);
    return Response.json(deps().reviews.status());
  });

  app.post("/reviews/resume", () => {
    deps().reviews.pause(false);
    return Response.json(deps().reviews.status());
  });

  /** "Check now": once a minute. */
  app.post("/reviews/check", async () => {
    const { reviews } = deps();
    const outcome = await owner(() => reviews.checkNow());
    if (outcome === "busy") throw new AppError("CONFLICT", "error.reviewsBusy");
    await deps().rearm();
    return Response.json({ ...reviews.status(), outcome });
  });

  app.get("/reviews", async (c) => {
    const query = reviewsQuerySchema.safeParse({ tab: c.req.query("tab") || undefined, rating: c.req.query("rating") || undefined, cursor: c.req.query("cursor") || undefined });
    if (!query.success) throw new AppError("VALIDATION_FAILED");
    return Response.json(await deps().reviews.list(query.data));
  });

  app.post("/reviews/:id/draft", async (c) => Response.json({ review: await owner(() => deps().reviews.redraft(reviewId(c))) }));

  app.post("/reviews/:id/approve", async (c) => {
    const id = reviewId(c);
    const input = await readJson(c.req.raw, reviewApproveSchema, 8 * 1024);
    return Response.json({ review: await owner(() => deps().reviews.approve(id, input, "app")) });
  });

  app.post("/reviews/:id/resolve", async (c) => Response.json({ review: await deps().reviews.resolve(reviewId(c), "app") }));

  app.post("/reviews/:id/discard", async (c) => Response.json({ review: await deps().reviews.discard(reviewId(c), "app") }));

  /** Deletes the reply Zuri published (the screen asks first); never anyone else's. */
  app.delete("/reviews/:id/reply", async (c) => Response.json({ review: await owner(() => deps().reviews.deleteReply(reviewId(c), "app")) }));
}
