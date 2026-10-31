import { TRANSCRIPTION_MODEL } from "@zuri/shared";
import { describe, expect, it } from "vitest";
import { MeteredAI } from "../src/ai/metered.ts";
import { MockAIProvider } from "../src/ai/mock.ts";
import { base64Bytes, estimatedSeconds, MockTranscriber, type Transcriber, WorkersAITranscriber } from "../src/ai/transcription.ts";
import type { AiLimits } from "../src/ai/usage.ts";
import { AppError } from "../src/http/errors.ts";
import { fakeAi, withAiWorld } from "./ai-fakes.ts";

// Voice to text (step 9): one clip of at most 60 s, an hour a day, counted before the call.

const LIMITS: AiLimits = { requestsPerDay: 100, neuronsPerDay: 9_000, maxOutputTokens: 1_024 };
const clip = (bytes: number) => btoa("x".repeat(bytes));
const seconds = (world: { db: { one<T>(sql: string): T | null } }) => world.db.one<{ audio_seconds: number; ai_errors: number; ai_aborted: number }>(`SELECT audio_seconds, ai_errors, ai_aborted FROM zur_usage_daily`);

describe("transcription", () => {
  it("measures base64 and estimates seconds at about 32 kbit/s, never above the clip cap", () => {
    expect(base64Bytes(btoa("abc"))).toBe(3);
    expect(base64Bytes(btoa("ab"))).toBe(2);
    expect(base64Bytes(btoa("a"))).toBe(1);
    expect(estimatedSeconds(1)).toBe(1);
    expect(estimatedSeconds(40_000)).toBe(10);
    expect(estimatedSeconds(2 * 1024 * 1024)).toBe(60);
  });

  it("charges the longer of the browser's length and the size's estimate, capped at 60 s", async () => {
    await withAiWorld(async (world) => {
      const ai = new MeteredAI(new MockAIProvider(), world.meter, () => LIMITS, undefined, new MockTranscriber());
      expect(await ai.transcribe(clip(40_000), 2, { locale: "pt-BR" })).toMatchObject({ seconds: 10 });
      expect(await ai.transcribe(clip(100), 59.2, { locale: "en" })).toEqual({ text: "(Simulated transcription) 1 s of audio.", seconds: 60 });
      expect(seconds(world)?.audio_seconds).toBe(70);
    });
  });

  it("a failed call is still charged and counted as an error; a stopped one as aborted", async () => {
    await withAiWorld(async (world) => {
      const failing: Transcriber = {
        model: TRANSCRIPTION_MODEL,
        billable: true,
        transcribe: async () => {
          throw new Error("5xx with secret detail");
        },
      };
      const ai = new MeteredAI(new MockAIProvider(), world.meter, () => LIMITS, undefined, failing);
      const error = await ai.transcribe(clip(100), 5, { locale: "pt-BR" }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("SERVICE_UNAVAILABLE");
      expect(seconds(world)).toMatchObject({ audio_seconds: 5, ai_errors: 1 });

      const stop = new AbortController();
      stop.abort();
      const aborted = await ai.transcribe(clip(100), 5, { locale: "pt-BR", signal: stop.signal }).catch((e: unknown) => e);
      expect((aborted as AppError).messageKey).toBe("error.aiAborted");
      // Stopped before the call: nothing counted.
      expect(seconds(world)?.audio_seconds).toBe(5);
    });
  });

  it("without a transcriber it is not configured, and nothing is counted", async () => {
    await withAiWorld(async (world) => {
      const ai = new MeteredAI(new MockAIProvider(), world.meter, () => LIMITS);
      expect((await ai.transcribe(clip(100), 5, { locale: "pt-BR" }).catch((e: unknown) => e)) as AppError).toMatchObject({ code: "NOT_CONFIGURED" });
      expect(seconds(world)).toBeNull();
    });
  });

  it("refuses the clip that would pass the Neuron cap, before the call", async () => {
    await withAiWorld(async (world) => {
      const { binding, calls } = fakeAi(() => ({ text: "oi" }));
      const ai = new MeteredAI(new MockAIProvider(), world.meter, () => ({ ...LIMITS, neuronsPerDay: 0.1 }), undefined, new WorkersAITranscriber(binding));
      const error = (await ai.transcribe(clip(100), 30, { locale: "pt-BR" }).catch((e: unknown) => e)) as AppError;
      expect(error).toMatchObject({ code: "AI_LIMIT_REACHED", details: expect.objectContaining({ limit: "neurons" }) });
      expect(calls).toHaveLength(0);
    });
  });

  it("asks Whisper in the owner's language with silence filtered, and reads its duration", async () => {
    const { binding, calls } = fakeAi(() => ({ text: "  comprar pão  ", transcription_info: { duration: 3.2 } }));
    const transcriber = new WorkersAITranscriber(binding);
    expect(await transcriber.transcribe("AAAA", { locale: "pt-BR" })).toEqual({ text: "comprar pão", seconds: 3.2 });
    expect(calls[0]).toMatchObject({ model: TRANSCRIPTION_MODEL, inputs: { audio: "AAAA", language: "pt", vad_filter: true } });

    const odd = new WorkersAITranscriber(fakeAi(() => ({ text: 42, transcription_info: { duration: -1 } })).binding);
    expect(await odd.transcribe("AAAA", { locale: "en" })).toEqual({ text: "", seconds: null });

    const broken = new WorkersAITranscriber(
      fakeAi(() => {
        throw new Error("boom");
      }).binding,
    );
    await expect(broken.transcribe("AAAA", { locale: "en" })).rejects.toBeInstanceOf(AppError);
  });
});
