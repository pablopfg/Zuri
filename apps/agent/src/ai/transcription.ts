import { type Locale, t, TRANSCRIPTION_MODEL, VOICE_LIMITS } from "@zuri/shared";
import { classifyAiError } from "./provider.ts";

/** Speech to text: the audio goes to the model only; nothing of it is stored or logged. */
export interface Transcriber {
  readonly model: string;
  readonly billable: boolean;
  transcribe(audio: string, options: { locale: Locale; signal?: AbortSignal | undefined }): Promise<{ text: string; seconds: number | null }>;
}

/** Bytes a base64 text decodes to. */
export function base64Bytes(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/**
 * Seconds to charge for a clip when the model reports none: about 32 kbit/s,
 * the rate browsers record Opus at, so a clip is never undercounted. Never
 * above the clip cap the browser keeps to.
 */
export function estimatedSeconds(bytes: number): number {
  return Math.min(VOICE_LIMITS.maxClipSeconds, Math.max(1, Math.ceil(bytes / 4_000)));
}

/** Whisper's codes for the owner's languages: the language steers recognition. */
const WHISPER_LANGUAGE: Record<Locale, string> = { "pt-BR": "pt", en: "en" };

interface WhisperOutput {
  text?: unknown;
  transcription_info?: { duration?: unknown };
}

/** Whisper on Workers AI. */
export class WorkersAITranscriber implements Transcriber {
  readonly model = TRANSCRIPTION_MODEL;
  readonly billable = true;

  constructor(private readonly binding: Ai) {}

  async transcribe(audio: string, options: { locale: Locale; signal?: AbortSignal | undefined }) {
    let result: WhisperOutput;
    try {
      result = (await this.binding.run(
        this.model as Parameters<Ai["run"]>[0],
        // Silence between words would otherwise come back as invented text.
        { audio, language: WHISPER_LANGUAGE[options.locale], vad_filter: true } as never,
        options.signal ? ({ signal: options.signal } as never) : undefined,
      )) as WhisperOutput;
    } catch (error) {
      throw classifyAiError(error);
    }
    const duration = result?.transcription_info?.duration;
    return {
      text: typeof result?.text === "string" ? result.text.trim() : "",
      seconds: typeof duration === "number" && Number.isFinite(duration) && duration > 0 ? duration : null,
    };
  }
}

/** The stand-in for local development and the tests: it never calls a model. */
export class MockTranscriber implements Transcriber {
  readonly model = "mock-whisper";
  readonly billable = false;

  async transcribe(audio: string, options: { locale: Locale; signal?: AbortSignal | undefined }) {
    options.signal?.throwIfAborted();
    const seconds = estimatedSeconds(base64Bytes(audio));
    return { text: t(options.locale, "ai.mock.transcription", { seconds }), seconds };
  }
}
