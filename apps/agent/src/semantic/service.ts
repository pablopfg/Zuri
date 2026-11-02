import { SEMANTIC_KINDS, SEMANTIC_LIMITS, type SemanticKind, type SemanticStatus, sha256Hex } from "@zuri/shared";
import type { MeteredAI } from "../ai/metered.ts";
import type { Database } from "../db/database.ts";
import type { InternalState } from "../db/internal-state.ts";
import { AppError } from "../http/errors.ts";
import { log } from "../log.ts";
import { createTriggers, dropTriggers, KIND_SOURCES, migrateSemantic } from "./schema.ts";
import { CHUNK, VectorStore } from "./store.ts";
import { keepBest } from "./vectors.ts";

const DAY_MS = 86_400_000;
/** After a failed indexing call, the next try waits this long: a model out of service is not hammered. */
export const SEMANTIC_RETRY_MS = 15 * 60_000;
/** Failed indexing calls in a row before the day's indexing stops: a fault that repeats is not paid for all day. */
export const SEMANTIC_MAX_FAILURES = 3;
/** The longest an indexing call may hold the shared alarm, and a question a turn or a search. */
export const SEMANTIC_INDEX_DEADLINE_MS = 30_000;
export const SEMANTIC_QUERY_DEADLINE_MS = 10_000;
/** Rows the full pass reads in one wake, at most. */
const SCAN_ROWS = 200;
/** Question vectors kept in memory, so typing the same search again costs nothing. */
const QUERY_CACHE = 32;

/** Where the full pass is: first each kind's items by rowid (0 to 3), then each kind's vectors by id (4 to 7), dropping the orphans. */
interface Sweep {
  step: number;
  after: number;
  afterId: string;
  /** Items the pass had to look at when it started, and how many it has looked at: the card's "waiting". */
  total: number;
  done: number;
}

/** The module's state: one row of zur_settings ("semantic"). */
interface State {
  on: boolean;
  schema: number;
  /** Bumped by "reindex": every vector of an older generation is made again, one batch at a time. */
  gen: number;
  sweep: Sweep | null;
  day: string;
  indexed: number;
  queries: number;
  /** Today's indexing stopped at the limit (texts or Neurons): it starts again at 00:00 UTC. */
  capped: boolean;
  waitUntil: string | null;
  /** Failed indexing calls in a row; at SEMANTIC_MAX_FAILURES the day's indexing stops. */
  failures: number;
}

const INITIAL: State = { on: false, schema: 0, gen: 1, sweep: null, day: "", indexed: 0, queries: 0, capped: false, waitUntil: null, failures: 0 };

export interface SemanticDeps {
  db: Database;
  state: InternalState;
  /** The model behind the meter: the only way to the embedder (rule P7). */
  ai: () => MeteredAI;
  /** A lockdown (step 16b) stops the background work. */
  lockdown: () => boolean;
  /** The owner's daily Neuron cap: the indexing uses at most a share of it. */
  neuronsPerDay: () => number;
  clock?: () => number;
}

/** Meaning hits of one search, best first per kind. */
export type MeaningHits = Partial<Record<SemanticKind, string[]>>;

/**
 * The search by meaning (step 17). Off by default; while it is off nothing of
 * it exists in the database and no call to the embedding model is made, so
 * every search behaves exactly as before (the step's acceptance).
 *
 * On: triggers queue every change to a memory, task, note or automation; the
 * shared alarm indexes the queue and a full pass over the existing items in
 * batches of SEMANTIC_LIMITS.batch, within a daily limit of texts and half the
 * day's Neuron cap. A search turns the question into one vector (cached) and
 * compares it with the stored ones in the object.
 */
export class SemanticSearch {
  readonly #store: VectorStore;
  readonly #cache = new Map<string, Float32Array>();
  #running = false;

  constructor(private readonly deps: SemanticDeps) {
    this.#store = new VectorStore(deps.db);
  }

  private now(): number {
    return this.deps.clock?.() ?? Date.now();
  }

  private read(): State {
    const raw = this.deps.state.get<string>("semantic");
    if (typeof raw !== "string") return { ...INITIAL };
    try {
      const parsed = JSON.parse(raw) as Partial<State>;
      return { ...INITIAL, ...parsed };
    } catch {
      return { ...INITIAL };
    }
  }

  private save(state: State): void {
    this.deps.state.set("semantic", JSON.stringify(state));
  }

  /** The state with today's counts started over on a new UTC day. */
  private today(state: State): State {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (state.day === day) return state;
    return { ...state, day, indexed: 0, queries: 0, capped: false, failures: 0 };
  }

  enabled(): boolean {
    return this.read().on;
  }

  /** Turns it on: the tables (first time), the triggers, and a full pass over what exists. */
  enable(): SemanticStatus {
    let state = this.read();
    if (!state.on) {
      const schema = migrateSemantic(this.deps.db, state.schema, (version) => {
        state = { ...state, schema: version };
        this.save(state);
      });
      createTriggers(this.deps.db);
      state = { ...state, schema, on: true, sweep: this.newSweep(), waitUntil: null };
      this.save(state);
    }
    return this.status();
  }

  /** Turns it off: the triggers and the queue go, the vectors stay (turning it on again redoes only what changed). */
  disable(): SemanticStatus {
    const state = this.read();
    if (state.on) {
      this.deps.db.transaction(() => {
        dropTriggers(this.deps.db);
        if (state.schema > 0) this.deps.db.run(`DELETE FROM zur_semantic_queue`);
        this.save({ ...state, on: false, sweep: null, waitUntil: null });
      });
      this.#cache.clear();
    }
    return this.status();
  }

  /** Makes every vector again, a batch at a time; until then the old ones keep answering. */
  reindex(): SemanticStatus {
    const state = this.read();
    if (!state.on) throw new AppError("CONFLICT");
    this.save({ ...state, gen: state.gen + 1, sweep: this.newSweep(), waitUntil: null });
    return this.status();
  }

  status(): SemanticStatus {
    const state = this.today(this.read());
    const counts = new Map(
      this.deps.db
        .all<{ kind: string; n: number }>(`SELECT kind, n FROM zur_counts WHERE kind IN ('memories', 'tasks', 'notes', 'automations', 'semantic')`)
        .map((row) => [row.kind, row.n]),
    );
    const total = ["memories", "tasks", "notes", "automations"].reduce((sum, kind) => sum + Math.max(0, counts.get(kind) ?? 0), 0);
    // The tables exist once a migration ran: its version is saved in the same transaction (no look at the schema table,
    // which reads a row per table, index and trigger).
    const tables = state.schema > 0;
    // At most SCAN_ROWS rows read to say how many changed items wait (the palette asks too): past that, the
    // count says "at least", and it moves as the rounds take them.
    const queued = state.on && tables ? (this.deps.db.one<{ n: number }>(`SELECT count(*) AS n FROM (SELECT 1 FROM zur_semantic_queue LIMIT ?)`, SCAN_ROWS)?.n ?? 0) : 0;
    const sweeping = state.on && state.sweep ? Math.max(0, state.sweep.total - state.sweep.done) : 0;
    const paused = !state.on ? null : this.deps.lockdown() ? "lockdown" : state.capped ? "limit" : null;
    return {
      enabled: state.on,
      ready: tables ? Math.max(0, counts.get("semantic") ?? 0) : 0,
      total,
      waiting: queued + sweeping,
      today: state.indexed,
      limitPerDay: SEMANTIC_LIMITS.indexPerDay,
      paused,
      resumesAt: paused === "limit" ? this.nextDay() : null,
    };
  }

  /** Today's questions and prepared texts (the bot's /uso), or null with the module off. */
  usage(): { queries: number; indexed: number } | null {
    const state = this.today(this.read());
    return state.on ? { queries: state.queries, indexed: state.indexed } : null;
  }

  /**
   * When the shared alarm should come back for the indexing: now while there
   * is work, the next UTC day once today's limit is reached, the end of the
   * wait after a failure; null with nothing to do (the watchers' round comes
   * every 15 minutes anyway, and picks up what a change queued).
   */
  nextDue(): string | null {
    const state = this.today(this.read());
    if (!state.on || this.deps.lockdown()) return null;
    if (state.capped) return this.nextDay();
    if (state.waitUntil && Date.parse(state.waitUntil) > this.now()) return state.waitUntil;
    // Without a model to call (a deploy with no AI binding) there is nothing the alarm could do.
    if (!this.embedder()) return null;
    const work = state.sweep !== null || this.deps.db.one(`SELECT 1 AS x FROM zur_semantic_queue LIMIT 1`) !== null;
    return work ? new Date(this.now()).toISOString() : null;
  }

  /**
   * One round of indexing, from the shared alarm: deletions and changes from
   * the queue first, then the full pass, at most one batch of texts in one
   * embedding call. Never during a lockdown; nothing at all with the module off.
   */
  async tick(): Promise<void> {
    if (this.#running) return;
    let state = this.today(this.read());
    if (!state.on || this.deps.lockdown()) return;
    if (state.waitUntil && Date.parse(state.waitUntil) > this.now()) return;
    if (state.capped) return;
    const room = Math.min(SEMANTIC_LIMITS.batch, SEMANTIC_LIMITS.indexPerDay - state.indexed);
    if (room <= 0) {
      this.save({ ...state, capped: true });
      return;
    }
    const embedding = this.embedder();
    if (!embedding) return;
    const ai = this.deps.ai();
    this.#running = true;
    try {
      const seen = new Set<string>();
      const candidates: { kind: SemanticKind; id: string; text: string; hash: string }[] = [];
      const queued: { kind: SemanticKind; id: string }[] = [];
      const hashOf = (text: string) => sha256Hex(`${state.gen}|${embedding.model}|${text}`);

      // The queue: deleted items lose their vector, unchanged ones leave it, changed ones wait for the batch.
      const rows = this.deps.db.all<{ kind: SemanticKind; item_id: string }>(`SELECT kind, item_id FROM zur_semantic_queue LIMIT ?`, SCAN_ROWS);
      for (const kind of SEMANTIC_KINDS) {
        const ids = rows.filter((row) => row.kind === kind).map((row) => row.item_id);
        if (ids.length === 0) continue;
        const live = this.texts(kind, ids);
        const gone = ids.filter((id) => !live.has(id));
        this.#store.remove(kind, gone);
        const stored = this.#store.hashes(kind, [...live.keys()]);
        const done = [...gone];
        for (const [id, text] of live) {
          const hash = await hashOf(text);
          if (stored.get(id) === hash) done.push(id);
          else if (candidates.length < room) {
            candidates.push({ kind, id, text, hash });
            seen.add(`${kind}:${id}`);
            queued.push({ kind, id });
          }
        }
        this.unqueue(kind, done);
      }

      // The full pass, on a copy: it moves on only once the batch is stored.
      let sweep = state.sweep ? { ...state.sweep } : null;
      let scanned = 0;
      while (sweep && candidates.length < room && scanned < SCAN_ROWS * 2) {
        if (sweep.step < SEMANTIC_KINDS.length) {
          const kind = SEMANTIC_KINDS[sweep.step] as SemanticKind;
          const source = KIND_SOURCES[kind];
          const items = this.deps.db.all<{ r: number; id: string; text: string }>(
            `SELECT rowid AS r, id, ${source.text} AS text FROM ${source.table} WHERE rowid > ? ORDER BY rowid LIMIT ?`,
            sweep.after,
            SCAN_ROWS,
          );
          if (items.length === 0) {
            sweep = { ...sweep, step: sweep.step + 1, after: 0, afterId: "" };
            continue;
          }
          const stored = this.#store.hashes(kind, items.map((item) => item.id));
          for (const item of items) {
            const hash = await hashOf(item.text);
            if (stored.get(item.id) !== hash && !seen.has(`${kind}:${item.id}`)) {
              if (candidates.length >= room) break;
              candidates.push({ kind, id: item.id, text: item.text, hash });
              seen.add(`${kind}:${item.id}`);
            }
            sweep.after = item.r;
            sweep.done++;
            scanned++;
          }
        } else if (sweep.step < SEMANTIC_KINDS.length * 2) {
          // Vectors of items deleted while the module was off (no trigger saw them go).
          const kind = SEMANTIC_KINDS[sweep.step - SEMANTIC_KINDS.length] as SemanticKind;
          const ids = this.deps.db
            .all<{ item_id: string }>(`SELECT item_id FROM zur_semantic_items WHERE kind = ? AND item_id > ? ORDER BY item_id LIMIT ?`, kind, sweep.afterId, SCAN_ROWS)
            .map((row) => row.item_id);
          if (ids.length === 0) {
            sweep = { ...sweep, step: sweep.step + 1, after: 0, afterId: "" };
            continue;
          }
          const live = this.texts(kind, ids);
          this.#store.remove(
            kind,
            ids.filter((id) => !live.has(id)),
          );
          sweep.afterId = ids[ids.length - 1] as string;
          scanned += ids.length;
        } else sweep = null;
      }

      if (candidates.length > 0) {
        let vectors: Float32Array[];
        try {
          const ceiling = this.deps.neuronsPerDay() * SEMANTIC_LIMITS.indexNeuronShare;
          vectors = await ai.embed(
            candidates.map((candidate) => [...candidate.text].slice(0, SEMANTIC_LIMITS.textChars).join("")),
            { ceiling, deadlineMs: SEMANTIC_INDEX_DEADLINE_MS },
          );
        } catch (error) {
          state = this.today(this.read());
          if (error instanceof AppError && error.code === "AI_LIMIT_REACHED") this.save({ ...state, capped: true });
          else {
            log("warn", "semantic_index_failed", { code: error instanceof AppError ? error.code : "INTERNAL_ERROR" });
            const failures = state.failures + 1;
            // A fault that repeats stops the day's indexing (rule P7: no endless retries, each one charged).
            this.save(
              failures >= SEMANTIC_MAX_FAILURES
                ? { ...state, failures, capped: true }
                : { ...state, failures, waitUntil: new Date(this.now() + SEMANTIC_RETRY_MS).toISOString() },
            );
          }
          return;
        }
        // The owner kept working while the model answered: what changed or went meanwhile is read again
        // here, with no await before the writes, so a stale text is never stored nor taken off the queue.
        for (const kind of SEMANTIC_KINDS) {
          const mine = candidates.flatMap((candidate, index) => (candidate.kind === kind ? [{ candidate, vector: vectors[index] as Float32Array }] : []));
          if (mine.length === 0) continue;
          const now = this.texts(
            kind,
            mine.map((entry) => entry.candidate.id),
          );
          const kept = mine.filter((entry) => now.get(entry.candidate.id) === entry.candidate.text);
          const gone = mine.filter((entry) => !now.has(entry.candidate.id)).map((entry) => entry.candidate.id);
          this.#store.put(
            kind,
            embedding.model,
            embedding.dims,
            kept.map((entry) => ({ id: entry.candidate.id, hash: entry.candidate.hash, vector: entry.vector })),
          );
          this.#store.remove(kind, gone);
          // A text changed meanwhile stays queued (its trigger found the row there), and the next round makes it.
          const settled = new Set([...kept.map((entry) => entry.candidate.id), ...gone]);
          this.unqueue(
            kind,
            queued.filter((item) => item.kind === kind && settled.has(item.id)).map((item) => item.id),
          );
          // A changed item the full pass found was not in the queue: its trigger put it there.
        }
      }
      // Read again: the owner may have switched it off or asked a reindex meanwhile.
      const latest = this.today(this.read());
      const sameRun = latest.on && latest.gen === state.gen && JSON.stringify(latest.sweep) === JSON.stringify(state.sweep);
      this.save({ ...latest, indexed: latest.indexed + candidates.length, sweep: sameRun ? sweep : latest.sweep, waitUntil: null, failures: 0 });
    } finally {
      this.#running = false;
    }
  }

  /**
   * The ids closest in meaning to `query`, best first per kind, or null when
   * the module is off or the question could not become a vector (the day's
   * limit, the model out): the caller then searches by the words alone.
   */
  async search(query: string, kinds: readonly SemanticKind[], limit: number, signal?: AbortSignal): Promise<MeaningHits | null> {
    let state = this.read();
    // A lockdown (step 16b) stops every call to the model, a question included.
    if (!state.on || state.schema === 0 || this.deps.lockdown()) return null;
    const text = [...query.trim()].slice(0, SEMANTIC_LIMITS.queryMaxChars).join("");
    if ([...text].length < SEMANTIC_LIMITS.queryMinChars) return {};
    const embedding = this.embedder();
    if (!embedding) return null;
    const ai = this.deps.ai();
    const key = `${embedding.model}|${text.toLowerCase()}`;
    let vector = this.#cache.get(key);
    if (!vector) {
      state = this.today(state);
      if (state.queries >= SEMANTIC_LIMITS.queriesPerDay) return null;
      this.save({ ...state, queries: state.queries + 1 });
      try {
        vector = (await ai.embed([text], { signal, deadlineMs: SEMANTIC_QUERY_DEADLINE_MS }))[0];
      } catch (error) {
        log("warn", "semantic_query_failed", { code: error instanceof AppError ? error.code : "INTERNAL_ERROR" });
        return null;
      }
      if (!vector) return null;
      if (this.#cache.size >= QUERY_CACHE) this.#cache.delete(this.#cache.keys().next().value as string);
      this.#cache.set(key, vector);
    }
    const hits = this.#store.search(kinds, embedding.model, vector);
    const out: MeaningHits = {};
    for (const kind of kinds) {
      out[kind] = keepBest(
        hits.filter((hit) => hit.kind === kind),
        embedding.floor,
        limit,
      ).map((hit) => hit.id);
    }
    return out;
  }

  /** This deploy's embedding model, or null when there is none (or the model could not be set up). */
  private embedder(): MeteredAI["embedding"] {
    try {
      return this.deps.ai().embedding;
    } catch {
      return null;
    }
  }

  /** The texts of the live items among `ids`. */
  private texts(kind: SemanticKind, ids: string[]): Map<string, string> {
    const source = KIND_SOURCES[kind];
    const out = new Map<string, string>();
    for (let i = 0; i < ids.length; i += CHUNK) {
      const part = ids.slice(i, i + CHUNK);
      const rows = this.deps.db.all<{ id: string; text: string }>(
        `SELECT id, ${source.text} AS text FROM ${source.table} WHERE id IN (${part.map(() => "?").join(", ")})`,
        ...part,
      );
      for (const row of rows) out.set(row.id, row.text);
    }
    return out;
  }

  private unqueue(kind: SemanticKind, ids: string[]): void {
    for (const id of ids) this.deps.db.run(`DELETE FROM zur_semantic_queue WHERE kind = ? AND item_id = ?`, kind, id);
  }

  private newSweep(): Sweep {
    const total = this.deps.db
      .all<{ n: number }>(`SELECT n FROM zur_counts WHERE kind IN ('memories', 'tasks', 'notes', 'automations')`)
      .reduce((sum, row) => sum + Math.max(0, row.n), 0);
    return { step: 0, after: 0, afterId: "", total, done: 0 };
  }

  private nextDay(): string {
    return new Date((Math.floor(this.now() / DAY_MS) + 1) * DAY_MS).toISOString();
  }
}
