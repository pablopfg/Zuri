import { describe, expect, it } from "vitest";
import {
  AI_LIMIT_RANGES,
  CHAT_MODEL_IDS,
  CHAT_MODELS,
  chatNeurons,
  DEFAULT_CHAT_MODEL,
  EMBEDDING_NEURONS_PER_MILLION,
  EMBEDDING_MODEL,
  isChatModel,
  modelLabel,
  neuronsToUsd,
  settingsSchema,
  TRANSCRIPTION_MODEL,
  TRANSCRIPTION_NEURONS_PER_MINUTE,
  TYPICAL_TURN_TOKENS,
  usageReportSchema,
  WORKERS_AI_PRICING,
} from "../src/index.ts";

const report = () => ({
  day: "2026-10-31",
  resetsAt: "2026-11-01T00:00:00.000Z",
  provider: "workers-ai",
  model: DEFAULT_CHAT_MODEL,
  today: { requests: 1, errors: 0, aborted: 0, neurons: 47.56, costUsd: 0.0005, audioSeconds: 0, models: [] as unknown[] },
  limits: { requestsPerDay: 200, neuronsPerDay: 9_000, audioSecondsPerDay: 3_600, maxOutputTokens: 1_024 },
  lastDays: [{ day: "2026-10-31", requests: 1, neurons: 47.56 }],
  pricing: { ...WORKERS_AI_PRICING },
});

describe("the dated Workers AI price table", () => {
  it("holds the rates checked on the pricing page on 31/10/2026", () => {
    expect(WORKERS_AI_PRICING).toEqual({
      asOf: "2026-10-31",
      sourceUrl: "https://developers.cloudflare.com/workers-ai/platform/pricing/",
      usdPer1000Neurons: 0.011,
      freeNeuronsPerDay: 10_000,
    });
    expect(CHAT_MODELS["@cf/zai-org/glm-4.7-flash"]).toMatchObject({ input: 5_500, output: 36_400 });
    expect(TRANSCRIPTION_NEURONS_PER_MINUTE).toBe(46.63);
    expect(EMBEDDING_NEURONS_PER_MILLION).toBe(1_075);
  });

  it("lists every selectable model with a rate, the default first, and no paid provider", () => {
    expect(CHAT_MODEL_IDS[0]).toBe(DEFAULT_CHAT_MODEL);
    expect(Object.keys(CHAT_MODELS).sort()).toEqual([...CHAT_MODEL_IDS].sort());
    for (const id of CHAT_MODEL_IDS) expect(id.startsWith("@cf/"), id).toBe(true);
    expect(isChatModel("@cf/zai-org/glm-4.7-flash")).toBe(true);
    for (const value of ["mock", "__proto__", "toString", "", 1, null]) expect(isChatModel(value)).toBe(false);
  });

  it("estimates a typical answer at about 48 Neurons on the default model, so the default cap fits ~190 of them", () => {
    const turn = chatNeurons(DEFAULT_CHAT_MODEL, TYPICAL_TURN_TOKENS.input, TYPICAL_TURN_TOKENS.output);
    expect(turn).toBeCloseTo(47.56, 6);
    expect(Math.floor(AI_LIMIT_RANGES.aiNeuronsPerDay.default / turn)).toBe(189);
    expect(neuronsToUsd(10_000)).toBeCloseTo(0.11, 9);
  });

  it("keeps the default Neuron cap under the free allocation, with room for other use of the account", () => {
    expect(AI_LIMIT_RANGES.aiNeuronsPerDay.default).toBeLessThan(WORKERS_AI_PRICING.freeNeuronsPerDay);
    // The owner's decision of 31/10/2026: one cap of 9,000, between 1,000 and 9,000.
    expect(AI_LIMIT_RANGES.aiNeuronsPerDay).toEqual({ min: 1_000, max: 9_000, default: 9_000 });
    expect(settingsSchema.shape.aiModel.safeParse("@cf/openai/gpt-oss-20b").success).toBe(false);
  });
});

describe("modelLabel", () => {
  it("names each chat model, the transcription and embedding models, and shows an unknown id as it is", () => {
    for (const id of CHAT_MODEL_IDS) expect(modelLabel(id)).toBe(CHAT_MODELS[id].label);
    expect(modelLabel(TRANSCRIPTION_MODEL)).toBe("Whisper Large v3 Turbo");
    expect(modelLabel(EMBEDDING_MODEL)).toBe("BGE-M3");
    expect(modelLabel("@cf/meta/llama-2-7b-chat-fp16")).toBe("@cf/meta/llama-2-7b-chat-fp16");
    expect(modelLabel("__proto__")).toBe("__proto__");
  });
});

describe("the usage report schema", () => {
  it("accepts the report the server sends", () => {
    expect(usageReportSchema.safeParse(report()).success).toBe(true);
  });

  it.each([
    ["a negative count", (r: ReturnType<typeof report>) => ({ ...r, today: { ...r.today, requests: -1 } })],
    ["a fractional request count", (r: ReturnType<typeof report>) => ({ ...r, today: { ...r.today, requests: 1.5 } })],
    ["an unknown provider", (r: ReturnType<typeof report>) => ({ ...r, provider: "openai" })],
    ["a model off the list", (r: ReturnType<typeof report>) => ({ ...r, model: "mock" })],
    ["a day in another format", (r: ReturnType<typeof report>) => ({ ...r, day: "31/10/2026" })],
    ["an extra field", (r: ReturnType<typeof report>) => ({ ...r, secret: "x" })],
    ["an unknown kind of usage", (r: ReturnType<typeof report>) => ({ ...r, today: { ...r.today, models: [{ model: "m", kind: "image", billable: true, calls: 1, inputTokens: 0, outputTokens: 0, estimatedTokens: 0, audioSeconds: 0, neurons: 0, costUsd: 0 }] } })],
  ])("refuses %s", (_name, change) => {
    expect(usageReportSchema.safeParse(change(report())).success).toBe(false);
  });
});
