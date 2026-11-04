import type { MeteredRequest } from "../src/ai/metered.ts";
import { runInDurableObject } from "cloudflare:test";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import { Database } from "../src/db/database.ts";
import { InternalState } from "../src/db/internal-state.ts";
import { migrate } from "../src/db/migrations.ts";
import { type DevGoogle, devGoogle, googleNetwork } from "../src/google/dev-google.ts";
import { GoogleCalendar } from "../src/google/service.ts";
import { type ReviewNotice, ReviewService } from "../src/reviews/service.ts";
import { NOON } from "./ai-fakes.ts";
import { testEnv } from "./helpers.ts";

/** The sample profile of the tests: one account, two locations. */
export const LOCATION = "accounts/101/locations/201";
export const OTHER = "accounts/101/locations/202";

export const PATTERN = {
  signature: "Equipe Exemplo",
  tone: "close" as const,
  templates: [
    "Muito obrigado pela sua avaliação, ficamos felizes com o seu carinho!",
    "Agradecemos de coração pela avaliação e esperamos ver você de novo em breve!",
    "Que alegria receber a sua avaliação, obrigado pela confiança de sempre!",
  ],
  banned: [] as string[],
};

/** What the fake model answers to one request; a function sees the request (the system prompt, the <data> blocks). */
export type Answer = string | ((req: MeteredRequest) => string) | Error;

export interface ReviewsWorld {
  db: Database;
  clock: { now: number };
  google: GoogleCalendar;
  sim: DevGoogle;
  reviews: ReviewService;
  notices: ReviewNotice[];
  lockdown: { active: boolean };
  /** Answers the model gives, in order: drafts and second readings alike. Empty: the model fails. */
  answers: Answer[];
  /** Every request the model got. */
  requests: MeteredRequest[];
  /** Neurons each model call reports. */
  neurons: number;
}

/** A positive draft as the model answers it. */
export const draftAnswer = (reply: string, extra: Partial<{ sentiment: string; health: boolean; language: string }> = {}) =>
  JSON.stringify({ sentiment: "positive", health: false, language: "pt-BR", reply, ...extra });
export const SECOND_OK = JSON.stringify({ ok: true, issues: [] });
export const SECOND_NO = JSON.stringify({ ok: false, issues: ["irony"] });

let objects = 0;

export function withReviewsWorld<T>(fn: (world: ReviewsWorld) => T | Promise<T>): Promise<T> {
  const stub = testEnv.AGENT.get(testEnv.AGENT.idFromName(`reviews-test-${++objects}`));
  return runInDurableObject(stub, async (_agent: ZuriAgent, state) => {
    const db = new Database(state.storage);
    migrate(db);
    const clock = { now: NOON };
    const tick = () => clock.now;
    const lockdown = { active: false };
    const sim = devGoogle({ clientId: testEnv.GOOGLE_CLIENT_ID, clientSecret: testEnv.GOOGLE_CLIENT_SECRET, clock: tick });
    sim.business.accounts.push({ name: "accounts/101", accountName: "Exemplo" });
    sim.business.locations.set("accounts/101", [
      { name: "locations/201", title: "Exemplo Centro" },
      { name: "locations/202", title: "Exemplo Filial" },
    ]);
    const google = new GoogleCalendar({
      db,
      state: new InternalState(db),
      clientId: () => testEnv.GOOGLE_CLIENT_ID,
      clientSecret: () => testEnv.GOOGLE_CLIENT_SECRET,
      credentialKey: testEnv.MCP_CREDENTIAL_KEY,
      pushSecret: () => testEnv.SESSION_SECRET,
      publicUrl: () => new URL("https://zuri.exemplo.com.br"),
      lockdown: () => lockdown.active,
      clock: tick,
    });
    google.network = googleNetwork(sim, { fetch: () => Promise.reject(new Error("no network in tests")) });
    const notices: ReviewNotice[] = [];
    const world: ReviewsWorld = {
      db,
      clock,
      google,
      sim,
      notices,
      lockdown,
      answers: [],
      requests: [],
      neurons: 5,
      reviews: undefined as unknown as ReviewService,
    };
    world.reviews = new ReviewService({
      db,
      google,
      ai: () => ({
        generate: async (req: MeteredRequest) => {
          world.requests.push(req);
          const next = world.answers.shift();
          if (next === undefined) throw new Error("model down");
          if (next instanceof Error) throw next;
          req.onNeurons?.(world.neurons);
          return { text: typeof next === "function" ? next(req) : next };
        },
      }),
      timeZone: () => "America/Sao_Paulo",
      lockdown: () => lockdown.active,
      notify: (notice) => notices.push(notice),
      clock: tick,
    });
    return fn(world);
  });
}

/** Google's consent for a purpose, through the simulated page. */
export async function consent(world: ReviewsWorld, purpose: "calendar" | "reviews") {
  const url = new URL(await world.google.begin("sessao", purpose));
  return world.google.finish({ state: url.searchParams.get("state") ?? "", code: `dev.${url.searchParams.get("code_challenge") ?? ""}` }, "sessao");
}

/** The calendar connected, the reviews joined to it, the profile picked and a first check (history only). */
export async function turnOn(world: ReviewsWorld, level: "approve" | "off" = "approve"): Promise<void> {
  await consent(world, "calendar");
  await consent(world, "reviews");
  await world.reviews.listLocations();
  world.reviews.configure({ locations: [LOCATION], ...PATTERN, level });
  await world.reviews.check("owner");
}

/** A review at Google, created now (the world's clock). */
export function add(world: ReviewsWorld, id: string, rating: number, comment?: string, extra: { name?: string; anonymous?: boolean; reply?: string; location?: string; at?: string } = {}) {
  return world.sim.business.add(extra.location ?? LOCATION, {
    id,
    rating,
    name: extra.name ?? "Ana Souza",
    ...(extra.anonymous ? { anonymous: true } : {}),
    ...(comment === undefined ? {} : { comment }),
    at: extra.at ?? new Date(world.clock.now).toISOString(),
    ...(extra.reply ? { reply: extra.reply } : {}),
  });
}

/** The next check, a quarter of an hour later. */
export async function later(world: ReviewsWorld, minutes = 16) {
  world.clock.now += minutes * 60_000;
  return world.reviews.check("alarm");
}

export const row = (world: ReviewsWorld, reviewId: string) =>
  world.db.one<Record<string, unknown> & { id: string; state: string; draft: string | null; draft_source: string | null; reasons: string; fallback: string }>(
    `SELECT * FROM zur_reviews WHERE google_name = ?`,
    `${LOCATION}/reviews/${reviewId}`,
  );
