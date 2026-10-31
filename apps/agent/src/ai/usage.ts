import {
  AUDIO_SECONDS_PER_DAY,
  CHAT_MODELS,
  type ChatModel,
  chatNeurons,
  isChatModel,
  type ModelUsage,
  neuronsToUsd,
  TRANSCRIPTION_NEURONS_PER_MINUTE,
  USAGE_RETENTION_DAYS,
  type UsageKind,
  type UsageReport,
  WORKERS_AI_PRICING,
} from "@zuri/shared";
import type { Database } from "../db/database.ts";
import { AppError } from "../http/errors.ts";
import type { StepUsage } from "./provider.ts";

/** The daily AI limits, from the owner's settings. */
export interface AiLimits {
  requestsPerDay: number;
  neuronsPerDay: number;
  maxOutputTokens: number;
}

/** A call counted before it runs. Settled once with what it used, or released if it never started. */
export interface Reservation {
  readonly day: string;
  readonly kind: UsageKind;
  readonly model: string;
  readonly billable: boolean;
  readonly neurons: number;
  readonly audioSeconds: number;
  done: boolean;
}

const DAY_MS = 86_400_000;

const LIMIT_MESSAGES = {
  requests: "error.aiLimit.requests",
  neurons: "error.aiLimit.neurons",
  audio: "error.aiLimit.audio",
} as const;

/** Rates of the dearest chat model of the list: the estimate for a billable model without its own rate. */
const DEAREST = Object.values(CHAT_MODELS).reduce((a, b) => (b.input + b.output > a.input + a.output ? b : a));

/** Neurons of one chat step; a billable model off the list is priced as the dearest, never as free. */
export function stepNeurons(usage: StepUsage): number {
  if (!usage.billable) return 0;
  const input = usage.input.reported + usage.input.estimated;
  const output = usage.output.reported + usage.output.estimated;
  if (isChatModel(usage.model)) return chatNeurons(usage.model, input, output);
  return (input * DEAREST.input + output * DEAREST.output) / 1_000_000;
}

export function audioNeurons(seconds: number): number {
  return (seconds / 60) * TRANSCRIPTION_NEURONS_PER_MINUTE;
}

const recordModelSql = `INSERT INTO zur_model_usage_daily
    (day, model, kind, billable, calls, input_reported, input_estimated, output_reported, output_estimated, audio_seconds, neurons, cost_usd)
  VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (day, model, kind, billable) DO UPDATE SET
    calls = calls + 1,
    input_reported = input_reported + excluded.input_reported,
    input_estimated = input_estimated + excluded.input_estimated,
    output_reported = output_reported + excluded.output_reported,
    output_estimated = output_estimated + excluded.output_estimated,
    audio_seconds = audio_seconds + excluded.audio_seconds,
    neurons = neurons + excluded.neurons,
    cost_usd = cost_usd + excluded.cost_usd`;

interface DayRow {
  ai_requests: number;
  ai_errors: number;
  ai_aborted: number;
  audio_seconds: number;
  neurons: number;
  cost_usd: number;
}

/**
 * The AI meter: every model call is counted against the day's limits *before*
 * it runs (rule P7), then settled with what it really used. Each check and its
 * count happen in one synchronous step of the Durable Object, which runs one
 * piece of JavaScript at a time: concurrent requests can never pass a limit
 * together. A call that reached the model is always settled, also when it failed
 * or was aborted halfway; one that never started gives its reservation back.
 *
 * Days are UTC days, because Cloudflare's free allocation resets at 00:00 UTC.
 */
export class UsageMeter {
  constructor(
    private readonly db: Database,
    private readonly clock: () => number = Date.now,
  ) {}

  static day(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
  }

  today(): string {
    return UsageMeter.day(this.clock());
  }

  /** The next 00:00 UTC, when the counters start over. */
  resetsAt(): string {
    return new Date((Math.floor(this.clock() / DAY_MS) + 1) * DAY_MS).toISOString();
  }

  /**
   * Counts one chat call of at most `inputTokens` + `maxOutputTokens`, or refuses
   * with AI_LIMIT_REACHED. `force` counts a call that already happened (the
   * provider made one more than was reserved) without checking anything.
   */
  reserveChat(
    call: { model: string; billable: boolean; inputTokens: number; maxOutputTokens: number },
    limits: AiLimits,
    force = false,
  ): Reservation {
    const estimate = stepNeurons({
      model: call.model,
      billable: call.billable,
      input: { reported: 0, estimated: call.inputTokens },
      output: { reported: 0, estimated: call.maxOutputTokens },
    });
    const day = this.today();
    const row = this.row(day);
    if (!force) {
      if ((row?.ai_requests ?? 0) >= limits.requestsPerDay) throw this.limitReached("requests", limits.requestsPerDay);
      if (call.billable && (row?.neurons ?? 0) + estimate > limits.neuronsPerDay) throw this.limitReached("neurons", limits.neuronsPerDay);
    }
    if (!row) this.startDay(day);
    this.db.run(
      `INSERT INTO zur_usage_daily (day, ai_requests, neurons) VALUES (?, 1, ?)
       ON CONFLICT (day) DO UPDATE SET ai_requests = ai_requests + 1, neurons = neurons + excluded.neurons`,
      day,
      estimate,
    );
    return { day, kind: "chat", model: call.model, billable: call.billable, neurons: estimate, audioSeconds: 0, done: false };
  }

  /** Counts `seconds` of audio to transcribe against the hour a day and the Neuron cap. */
  reserveAudio(call: { model: string; seconds: number }, limits: AiLimits): Reservation {
    const seconds = Math.ceil(call.seconds);
    const estimate = audioNeurons(seconds);
    const day = this.today();
    const row = this.row(day);
    if ((row?.audio_seconds ?? 0) + seconds > AUDIO_SECONDS_PER_DAY) throw this.limitReached("audio", AUDIO_SECONDS_PER_DAY);
    if ((row?.neurons ?? 0) + estimate > limits.neuronsPerDay) throw this.limitReached("neurons", limits.neuronsPerDay);
    if (!row) this.startDay(day);
    this.db.run(
      `INSERT INTO zur_usage_daily (day, audio_seconds, neurons) VALUES (?, ?, ?)
       ON CONFLICT (day) DO UPDATE SET audio_seconds = audio_seconds + excluded.audio_seconds, neurons = neurons + excluded.neurons`,
      day,
      seconds,
      estimate,
    );
    return { day, kind: "transcription", model: call.model, billable: true, neurons: estimate, audioSeconds: seconds, done: false };
  }

  /** Replaces a chat reservation with what the step used, on the day it was reserved. */
  settle(reservation: Reservation, usage: StepUsage): void {
    if (reservation.done) return;
    reservation.done = true;
    const neurons = stepNeurons(usage);
    const cost = neuronsToUsd(neurons);
    this.db.transaction(() => {
      this.adjust(reservation.day, neurons - reservation.neurons, cost);
      this.db.run(
        recordModelSql,
        reservation.day,
        usage.model,
        reservation.kind,
        usage.billable ? 1 : 0,
        usage.input.reported,
        usage.input.estimated,
        usage.output.reported,
        usage.output.estimated,
        0,
        neurons,
        cost,
      );
    });
  }

  /** Settles an audio reservation with the seconds really sent (never more than reserved). */
  settleAudio(reservation: Reservation, seconds: number): void {
    if (reservation.done) return;
    reservation.done = true;
    const used = Math.min(Math.max(0, Math.ceil(seconds)), reservation.audioSeconds);
    const neurons = audioNeurons(used);
    const cost = neuronsToUsd(neurons);
    this.db.transaction(() => {
      this.db.run(
        `UPDATE zur_usage_daily SET audio_seconds = max(0, audio_seconds - ?) WHERE day = ?`,
        reservation.audioSeconds - used,
        reservation.day,
      );
      this.adjust(reservation.day, neurons - reservation.neurons, cost);
      this.db.run(recordModelSql, reservation.day, reservation.model, reservation.kind, 1, 0, 0, 0, 0, used, neurons, cost);
    });
  }

  /** Gives back a reservation whose call never reached the model. */
  release(reservation: Reservation): void {
    if (reservation.done) return;
    reservation.done = true;
    this.db.run(
      `UPDATE zur_usage_daily SET
         ai_requests = max(0, ai_requests - ?),
         audio_seconds = max(0, audio_seconds - ?),
         neurons = max(0, neurons - ?)
       WHERE day = ?`,
      reservation.kind === "chat" ? 1 : 0,
      reservation.audioSeconds,
      reservation.neurons,
      reservation.day,
    );
  }

  /** One turn that ended in an error, or that was stopped before its end. */
  failed(day: string, aborted: boolean): void {
    this.db.run(
      aborted
        ? `INSERT INTO zur_usage_daily (day, ai_aborted) VALUES (?, 1) ON CONFLICT (day) DO UPDATE SET ai_aborted = ai_aborted + 1`
        : `INSERT INTO zur_usage_daily (day, ai_errors) VALUES (?, 1) ON CONFLICT (day) DO UPDATE SET ai_errors = ai_errors + 1`,
      day,
    );
  }

  /** Today against the limits, and the last 7 days: about 7 + one row per model used today. */
  report(limits: AiLimits, provider: UsageReport["provider"], model: ChatModel): UsageReport {
    const day = this.today();
    const row = this.row(day);
    const from = UsageMeter.day(this.clock() - 6 * DAY_MS);
    const models = this.db
      .all<{
        model: string;
        kind: UsageKind;
        billable: number;
        calls: number;
        input_reported: number;
        input_estimated: number;
        output_reported: number;
        output_estimated: number;
        audio_seconds: number;
        neurons: number;
        cost_usd: number;
      }>(`SELECT * FROM zur_model_usage_daily WHERE day = ? ORDER BY neurons DESC, calls DESC, model`, day)
      .map(
        (m): ModelUsage => ({
          model: m.model,
          kind: m.kind,
          billable: m.billable === 1,
          calls: m.calls,
          inputTokens: m.input_reported + m.input_estimated,
          outputTokens: m.output_reported + m.output_estimated,
          estimatedTokens: m.input_estimated + m.output_estimated,
          audioSeconds: m.audio_seconds,
          neurons: m.neurons,
          costUsd: m.cost_usd,
        }),
      );
    const lastDays = this.db.all<{ day: string; requests: number; neurons: number }>(
      `SELECT day, ai_requests AS requests, neurons FROM zur_usage_daily WHERE day >= ? AND day <= ? ORDER BY day`,
      from,
      day,
    );
    return {
      day,
      resetsAt: this.resetsAt(),
      provider,
      model,
      today: {
        requests: row?.ai_requests ?? 0,
        errors: row?.ai_errors ?? 0,
        aborted: row?.ai_aborted ?? 0,
        neurons: row?.neurons ?? 0,
        costUsd: row?.cost_usd ?? 0,
        audioSeconds: row?.audio_seconds ?? 0,
        models,
      },
      limits: {
        requestsPerDay: limits.requestsPerDay,
        neuronsPerDay: limits.neuronsPerDay,
        audioSecondsPerDay: AUDIO_SECONDS_PER_DAY,
        maxOutputTokens: limits.maxOutputTokens,
      },
      lastDays,
      pricing: { ...WORKERS_AI_PRICING },
    };
  }

  private row(day: string): DayRow | null {
    return this.db.one<DayRow>(
      `SELECT ai_requests, ai_errors, ai_aborted, audio_seconds, neurons, cost_usd FROM zur_usage_daily WHERE day = ?`,
      day,
    );
  }

  /** A day's first call also removes the history past the retention: 90 days, today included (rule P13). */
  private startDay(day: string): void {
    const cutoff = UsageMeter.day(Date.parse(`${day}T00:00:00Z`) - USAGE_RETENTION_DAYS * DAY_MS);
    this.db.run(`DELETE FROM zur_usage_daily WHERE day <= ?`, cutoff);
    this.db.run(`DELETE FROM zur_model_usage_daily WHERE day <= ?`, cutoff);
  }

  private adjust(day: string, neurons: number, cost: number): void {
    // An absent row (it was purged, or the day was never reserved) is created, so nothing is lost.
    this.db.run(
      `INSERT INTO zur_usage_daily (day, neurons, cost_usd) VALUES (?, max(0, ?), ?)
       ON CONFLICT (day) DO UPDATE SET neurons = max(0, neurons + ?), cost_usd = cost_usd + excluded.cost_usd`,
      day,
      neurons,
      cost,
      neurons,
    );
  }

  private limitReached(limit: "requests" | "neurons" | "audio", max: number): AppError {
    const resetsAt = this.resetsAt();
    const retryAfter = Math.max(1, Math.ceil((Date.parse(resetsAt) - this.clock()) / 1000));
    return new AppError("AI_LIMIT_REACHED", LIMIT_MESSAGES[limit], { limit, max, resetsAt, retryAfter });
  }
}
