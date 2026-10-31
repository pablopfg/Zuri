import { AUDIO_SECONDS_PER_DAY, CHAT_MODELS, chatNeurons, neuronsToUsd, TRANSCRIPTION_MODEL, usageReportSchema } from "@zuri/shared";
import { describe, expect, it } from "vitest";
import type { StepUsage } from "../src/ai/provider.ts";
import { type AiLimits, audioNeurons, stepNeurons, UsageMeter } from "../src/ai/usage.ts";
import { AppError } from "../src/http/errors.ts";
import { NOON, withAiWorld } from "./ai-fakes.ts";

const GLM = "@cf/zai-org/glm-4.7-flash";
const LIMITS: AiLimits = { requestsPerDay: 3, neuronsPerDay: 9_000, maxOutputTokens: 1_024 };
const chat = (inputTokens = 1_000, maxOutputTokens = 100, billable = true) => ({ model: GLM, billable, inputTokens, maxOutputTokens });
const used = (input: number, output: number, reported = true, model: string = GLM): StepUsage => ({
  model,
  billable: model !== "mock",
  input: reported ? { reported: input, estimated: 0 } : { reported: 0, estimated: input },
  output: reported ? { reported: output, estimated: 0 } : { reported: 0, estimated: output },
});

function refusal(fn: () => unknown): AppError {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("pricing", () => {
  it("prices a chat step by the dated table, in Neurons and list US$", () => {
    // 6,000 tokens in and 400 out on glm-4.7-flash: 33 + 14.56 Neurons.
    expect(chatNeurons(GLM, 6_000, 400)).toBeCloseTo(47.56, 6);
    expect(stepNeurons(used(6_000, 400))).toBeCloseTo(47.56, 6);
    expect(stepNeurons(used(6_000, 400, false))).toBeCloseTo(47.56, 6);
    expect(neuronsToUsd(1_000)).toBeCloseTo(0.011, 9);
    expect(audioNeurons(60)).toBeCloseTo(46.63, 6);
  });

  it("charges nothing for the mock, and prices an unknown billable model as the dearest of the list, never as free", () => {
    expect(stepNeurons(used(6_000, 400, false, "mock"))).toBe(0);
    const dearest = Math.max(...Object.values(CHAT_MODELS).map((r) => r.input * 6_000 + r.output * 400)) / 1_000_000;
    expect(stepNeurons({ ...used(6_000, 400), model: "@cf/someone/new-model" })).toBeCloseTo(dearest, 6);
  });
});

describe("the daily limits, counted before the call", () => {
  it("allows the request that reaches the limit and refuses the next one (n−1, n, n+1)", async () => {
    await withAiWorld(({ meter }) => {
      meter.reserveChat(chat(), LIMITS);
      meter.reserveChat(chat(), LIMITS); // n−1 = 2
      meter.reserveChat(chat(), LIMITS); // n = 3
      const error = refusal(() => meter.reserveChat(chat(), LIMITS)); // n+1
      expect(error.code).toBe("AI_LIMIT_REACHED");
      expect(error.messageKey).toBe("error.aiLimit.requests");
      expect(error.details).toEqual({ limit: "requests", max: 3, resetsAt: "2026-11-01T00:00:00.000Z", retryAfter: 12 * 3600 });
      expect(meter.report(LIMITS, "workers-ai", GLM).today.requests).toBe(3);
    });
  });

  it("refuses a call whose estimate would pass the Neuron cap, and allows one that lands exactly on it", async () => {
    await withAiWorld(({ meter }) => {
      // 100,000 tokens of input on glm: exactly 550 Neurons each, with no output.
      const exact = { model: GLM, billable: true, inputTokens: 100_000, maxOutputTokens: 0 };
      const limits = { ...LIMITS, requestsPerDay: 100, neuronsPerDay: 1_100 };
      meter.reserveChat(exact, limits);
      meter.reserveChat(exact, limits); // 1,100: on the cap
      const error = refusal(() => meter.reserveChat({ ...exact, inputTokens: 1 }, limits));
      expect(error.details).toMatchObject({ limit: "neurons", max: 1_100 });
      expect(error.messageKey).toBe("error.aiLimit.neurons");
      expect(meter.report(limits, "workers-ai", GLM).today).toMatchObject({ requests: 2, neurons: 1_100 });
    });
  });

  it("lets the mock pass the Neuron cap (it spends none) but still counts its requests", async () => {
    await withAiWorld(({ meter }) => {
      const limits = { ...LIMITS, neuronsPerDay: 500 };
      meter.reserveChat({ ...chat(10_000_000), billable: false, model: "mock" }, limits);
      expect(meter.report(limits, "mock", GLM).today).toMatchObject({ requests: 1, neurons: 0 });
    });
  });

  it("settles a reservation with what the call used, once", async () => {
    await withAiWorld(({ meter }) => {
      const reservation = meter.reserveChat(chat(6_000, 1_024), LIMITS);
      expect(reservation.neurons).toBeCloseTo(chatNeurons(GLM, 6_000, 1_024), 6);
      meter.settle(reservation, used(5_000, 300));
      meter.settle(reservation, used(5_000, 300));
      const today = meter.report(LIMITS, "workers-ai", GLM).today;
      expect(today.neurons).toBeCloseTo(chatNeurons(GLM, 5_000, 300), 6);
      expect(today.costUsd).toBeCloseTo(neuronsToUsd(chatNeurons(GLM, 5_000, 300)), 9);
      expect(today.models).toEqual([
        {
          model: GLM,
          kind: "chat",
          billable: true,
          calls: 1,
          inputTokens: 5_000,
          outputTokens: 300,
          estimatedTokens: 0,
          audioSeconds: 0,
          neurons: expect.closeTo(chatNeurons(GLM, 5_000, 300), 6),
          costUsd: expect.closeTo(neuronsToUsd(chatNeurons(GLM, 5_000, 300)), 9),
        },
      ]);
    });
  });

  it("gives a reservation back when its call never started, and never after it was settled", async () => {
    await withAiWorld(({ meter }) => {
      const never = meter.reserveChat(chat(), LIMITS);
      meter.release(never);
      meter.release(never);
      expect(meter.report(LIMITS, "workers-ai", GLM).today).toMatchObject({ requests: 0, neurons: 0 });
      const ran = meter.reserveChat(chat(), LIMITS);
      meter.settle(ran, used(1_000, 10));
      meter.release(ran);
      expect(meter.report(LIMITS, "workers-ai", GLM).today.requests).toBe(1);
    });
  });

  it("keeps a call that crossed midnight UTC on the day it was counted, and starts the new day at zero", async () => {
    await withAiWorld(({ meter, clock }) => {
      clock.now = Date.parse("2026-10-31T23:59:59.999Z");
      const late = meter.reserveChat(chat(), LIMITS);
      meter.reserveChat(chat(), LIMITS);
      meter.reserveChat(chat(), LIMITS);
      expect(refusal(() => meter.reserveChat(chat(), LIMITS)).details).toMatchObject({ retryAfter: 1 });
      clock.now = Date.parse("2026-11-01T00:00:00.000Z");
      meter.settle(late, used(2_000, 50));
      const report = meter.report(LIMITS, "workers-ai", GLM);
      expect(report.day).toBe("2026-11-01");
      expect(report.resetsAt).toBe("2026-11-02T00:00:00.000Z");
      expect(report.today.requests).toBe(0);
      expect(report.lastDays.find((d) => d.day === "2026-10-31")).toEqual({ day: "2026-10-31", requests: 3, neurons: expect.any(Number) });
      expect(report.today.models).toEqual([]);
      meter.reserveChat(chat(), LIMITS);
    });
  });

  it("measures the day in UTC, not in the owner's time zone (Cloudflare's allocation resets at 00:00 UTC)", () => {
    // 21:30 in São Paulo on the 31st is already the 1st in UTC.
    expect(UsageMeter.day(Date.parse("2026-11-01T00:30:00Z"))).toBe("2026-11-01");
    expect(new UsageMeter(null as never, () => Date.parse("2026-10-31T23:00:00Z")).resetsAt()).toBe("2026-11-01T00:00:00.000Z");
  });

  it("removes history older than 90 days when a new day starts, and keeps the 89th", async () => {
    await withAiWorld(({ db, meter, clock }) => {
      const insert = (day: string) => {
        db.run(`INSERT INTO zur_usage_daily (day, ai_requests) VALUES (?, 1)`, day);
        db.run(`INSERT INTO zur_model_usage_daily (day, model, kind, billable, calls) VALUES (?, 'x', 'chat', 1, 1)`, day);
      };
      insert("2026-08-02"); // 90 days before 31/10: removed
      insert("2026-08-03"); // 89 days before: kept
      meter.reserveChat(chat(), LIMITS);
      expect(db.all(`SELECT day FROM zur_usage_daily ORDER BY day`)).toEqual([{ day: "2026-08-03" }, { day: "2026-10-31" }]);
      expect(db.all(`SELECT day FROM zur_model_usage_daily ORDER BY day`)).toEqual([{ day: "2026-08-03" }]);
      // Not again on the same day: the second call of the day reads one row and writes one.
      db.usage.rowsRead = 0;
      db.usage.rowsWritten = 0;
      clock.now += 1_000;
      meter.reserveChat(chat(), LIMITS);
      expect(db.usage.rowsRead).toBeLessThanOrEqual(2);
      expect(db.usage.rowsWritten).toBe(1);
    });
  });

  it("caps audio at one hour a day, exactly, and gives back the seconds not used", async () => {
    await withAiWorld(({ meter }) => {
      const limits = { ...LIMITS, neuronsPerDay: 10_000 };
      const first = meter.reserveAudio({ model: TRANSCRIPTION_MODEL, seconds: AUDIO_SECONDS_PER_DAY - 60 }, limits);
      meter.settleAudio(first, AUDIO_SECONDS_PER_DAY - 120); // 60 s back
      meter.reserveAudio({ model: TRANSCRIPTION_MODEL, seconds: 119.2 }, limits); // rounds up to 120: lands on 3,600
      const error = refusal(() => meter.reserveAudio({ model: TRANSCRIPTION_MODEL, seconds: 0.5 }, limits));
      expect(error.details).toMatchObject({ limit: "audio", max: AUDIO_SECONDS_PER_DAY });
      const today = meter.report(limits, "workers-ai", GLM).today;
      expect(today.audioSeconds).toBe(AUDIO_SECONDS_PER_DAY);
      expect(today.requests).toBe(0);
      expect(today.models[0]).toMatchObject({ model: TRANSCRIPTION_MODEL, kind: "transcription", audioSeconds: AUDIO_SECONDS_PER_DAY - 120 });
    });
  });

  it("checks audio against the Neuron cap too, and settles the length the model heard, once, even above the reservation", async () => {
    await withAiWorld(({ meter }) => {
      const limits = { ...LIMITS, neuronsPerDay: 500 };
      // 11 minutes = 512.9 Neurons: over a cap of 500.
      expect(refusal(() => meter.reserveAudio({ model: TRANSCRIPTION_MODEL, seconds: 660 }, limits)).details).toMatchObject({ limit: "neurons" });
      const r = meter.reserveAudio({ model: TRANSCRIPTION_MODEL, seconds: 60 }, limits);
      // A low-bitrate file: estimated at 60 s, heard as 10 minutes. The call was made, so all of it counts.
      meter.settleAudio(r, 600);
      meter.settleAudio(r, 9_999);
      expect(meter.report(limits, "workers-ai", GLM).today).toMatchObject({ audioSeconds: 600, neurons: expect.closeTo(466.3, 6) });
      // The next clip finds the Neuron cap nearly spent.
      expect(refusal(() => meter.reserveAudio({ model: TRANSCRIPTION_MODEL, seconds: 60 }, limits)).details).toMatchObject({ limit: "neurons" });
    });
  });

  it("counts failures and stops apart from the requests", async () => {
    await withAiWorld(({ meter }) => {
      meter.failed(meter.today(), false);
      meter.failed(meter.today(), true);
      meter.failed(meter.today(), true);
      expect(meter.report(LIMITS, "workers-ai", GLM).today).toMatchObject({ errors: 1, aborted: 2, requests: 0 });
    });
  });
});

describe("the usage report", () => {
  it("matches the schema the interface parses, with the last 7 days only", async () => {
    await withAiWorld(({ db, meter, clock }) => {
      for (let i = 0; i < 10; i++) {
        clock.now = NOON - i * 86_400_000;
        meter.settle(meter.reserveChat(chat(), LIMITS), used(1_000, 100));
      }
      clock.now = NOON;
      db.usage.rowsRead = 0;
      const report = meter.report(LIMITS, "workers-ai", GLM);
      expect(usageReportSchema.safeParse(report).success).toBe(true);
      expect(report.lastDays.map((d) => d.day)).toEqual([
        "2026-10-25",
        "2026-10-26",
        "2026-10-27",
        "2026-10-28",
        "2026-10-29",
        "2026-10-30",
        "2026-10-31",
      ]);
      expect(report.limits).toEqual({ requestsPerDay: 3, neuronsPerDay: 9_000, audioSecondsPerDay: AUDIO_SECONDS_PER_DAY, maxOutputTokens: 1_024 });
      expect(report.pricing.asOf).toBe("2026-10-31");
      // Today's row, its model rows and the 7 days: about a page, not the history.
      expect(db.usage.rowsRead).toBeLessThanOrEqual(10);
    });
  });

  it("refuses rows the tables do not allow", async () => {
    await withAiWorld(({ db }) => {
      expect(() => db.run(`INSERT INTO zur_usage_daily (day, ai_requests) VALUES ('2026-10-31', -1)`)).toThrow();
      expect(() => db.run(`INSERT INTO zur_usage_daily (day) VALUES ('31/10')`)).toThrow();
      expect(() => db.run(`INSERT INTO zur_model_usage_daily (day, model, kind, billable) VALUES ('2026-10-31', 'x', 'image', 1)`)).toThrow();
      expect(() => db.run(`INSERT INTO zur_model_usage_daily (day, model, kind, billable) VALUES ('2026-10-31', '', 'chat', 1)`)).toThrow();
    });
  });
});
