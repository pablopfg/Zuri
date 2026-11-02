import { SEMANTIC_LIMITS, type SemanticKind } from "@zuri/shared";
import type { Database } from "../db/database.ts";
import { cosineInt8, quantize } from "./vectors.ts";

/** One block as it lives in memory while it is changed or read. */
interface Block {
  id: number;
  kind: SemanticKind;
  model: string;
  ids: (string | null)[];
  scales: Float32Array;
  vectors: Int8Array;
  used: number;
}

interface BlockRow {
  id: number;
  kind: SemanticKind;
  model: string;
  used: number;
  ids: string;
  scales: ArrayBuffer;
  vectors: ArrayBuffer;
}

/** A vector found close to the question. */
export interface Hit {
  kind: SemanticKind;
  id: string;
  score: number;
}

const SIZE = SEMANTIC_LIMITS.blockSize;
/** Ids per `IN (...)`: the platform binds at most 100 values per statement, the kind included. */
export const CHUNK = 90;

/** Bound parameters for `IN (...)`: one `?` per value; nothing typed by the owner is ever SQL. */
const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/**
 * The vectors, packed SEMANTIC_LIMITS.blockSize to a row (one row per block,
 * whatever the number of vectors in it). Writing one item rewrites its block
 * once per call, however many of the call's items land in it.
 */
export class VectorStore {
  constructor(private readonly db: Database) {}

  /** The stored text hash of each of `ids` that has a vector. */
  hashes(kind: SemanticKind, ids: string[]): Map<string, string> {
    const out = new Map<string, string>();
    for (let i = 0; i < ids.length; i += CHUNK) {
      const part = ids.slice(i, i + CHUNK);
      const rows = this.db.all<{ item_id: string; hash: string }>(
        `SELECT item_id, hash FROM zur_semantic_items WHERE kind = ? AND item_id IN (${marks(part.length)})`,
        kind,
        ...part,
      );
      for (const row of rows) out.set(row.item_id, row.hash);
    }
    return out;
  }

  /**
   * Stores each item's unit vector with its text hash, in one transaction: an
   * item that had a vector gets it replaced in place (same model) or moved (a
   * new model), a new one takes a free slot.
   */
  put(kind: SemanticKind, model: string, dims: number, entries: { id: string; hash: string; vector: Float32Array }[]): void {
    if (entries.length === 0) return;
    this.db.transaction(() => {
      const touched = new Map<number, Block>();
      const where = this.locate(kind, entries.map((entry) => entry.id));
      for (const entry of entries) {
        const at = where.get(entry.id);
        let block = at ? this.block(at.block, touched) : null;
        let slot = at?.slot ?? -1;
        if (block && (block.model !== model || block.vectors.length !== SIZE * dims)) {
          // Made by another model: its slot is freed, the new vector goes with its own model.
          this.free(block, slot);
          block = null;
        }
        if (!block) {
          block = this.freeBlock(kind, model, dims, touched);
          slot = block.ids.indexOf(null);
          block.used++;
        }
        const { q, scale } = quantize(entry.vector);
        block.ids[slot] = entry.id;
        block.scales[slot] = scale;
        block.vectors.set(q, slot * dims);
        this.db.run(
          `INSERT INTO zur_semantic_items (kind, item_id, hash, block, slot) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (kind, item_id) DO UPDATE SET hash = excluded.hash, block = excluded.block, slot = excluded.slot`,
          kind,
          entry.id,
          entry.hash,
          block.id,
          slot,
        );
      }
      for (const block of touched.values()) this.save(block);
    });
  }

  /** Forgets the vectors of `ids` (deleted items): their slots are freed, an empty block goes. */
  remove(kind: SemanticKind, ids: string[]): void {
    if (ids.length === 0) return;
    this.db.transaction(() => {
      const touched = new Map<number, Block>();
      const where = this.locate(kind, ids);
      for (const [id, at] of where) {
        const block = this.block(at.block, touched);
        if (block) this.free(block, at.slot);
        this.db.run(`DELETE FROM zur_semantic_items WHERE kind = ? AND item_id = ?`, kind, id);
      }
      for (const block of touched.values()) this.save(block);
    });
  }

  /**
   * Every stored vector of `kinds` made by `model`, scored against the unit
   * `query`: one row read per block. The comparison runs here, in the
   * object, never in the Worker (rule P6).
   */
  search(kinds: readonly SemanticKind[], model: string, query: Float32Array): Hit[] {
    if (kinds.length === 0) return [];
    const rows = this.db.all<BlockRow>(
      `SELECT id, kind, model, used, ids, scales, vectors FROM zur_semantic_vectors WHERE model = ? AND used > 0 AND kind IN (${marks(kinds.length)})`,
      model,
      ...kinds,
    );
    const hits: Hit[] = [];
    for (const row of rows) {
      const vectors = new Int8Array(row.vectors);
      // A block of another size (a model that changed its output) is skipped, never misread.
      if (vectors.length !== SIZE * query.length) continue;
      const scales = new Float32Array(row.scales);
      const ids = parseIds(row.ids);
      for (let slot = 0; slot < SIZE; slot++) {
        const id = ids[slot];
        if (!id) continue;
        hits.push({ kind: row.kind, id, score: cosineInt8(query, vectors, slot, scales[slot] ?? 0) });
      }
    }
    return hits;
  }

  private locate(kind: SemanticKind, ids: string[]): Map<string, { block: number; slot: number }> {
    const out = new Map<string, { block: number; slot: number }>();
    for (let i = 0; i < ids.length; i += CHUNK) {
      const part = ids.slice(i, i + CHUNK);
      const rows = this.db.all<{ item_id: string; block: number; slot: number }>(
        `SELECT item_id, block, slot FROM zur_semantic_items WHERE kind = ? AND item_id IN (${marks(part.length)})`,
        kind,
        ...part,
      );
      for (const row of rows) out.set(row.item_id, { block: row.block, slot: row.slot });
    }
    return out;
  }

  private block(id: number, touched: Map<number, Block>): Block | null {
    const cached = touched.get(id);
    if (cached) return cached;
    const row = this.db.one<BlockRow>(`SELECT id, kind, model, used, ids, scales, vectors FROM zur_semantic_vectors WHERE id = ?`, id);
    if (!row) return null;
    const block: Block = {
      id: row.id,
      kind: row.kind,
      model: row.model,
      used: row.used,
      ids: parseIds(row.ids),
      // Copies: the row's buffers are not ours to change.
      scales: new Float32Array(row.scales.slice(0)),
      vectors: new Int8Array(row.vectors.slice(0)),
    };
    touched.set(id, block);
    return block;
  }

  /** A block of `kind` and `model` with a free slot: one being changed, a stored one, or a new one. */
  private freeBlock(kind: SemanticKind, model: string, dims: number, touched: Map<number, Block>): Block {
    for (const block of touched.values()) {
      if (block.kind === kind && block.model === model && block.ids.includes(null) && block.vectors.length === SIZE * dims) return block;
    }
    const row = this.db.one<{ id: number }>(
      `SELECT id FROM zur_semantic_vectors WHERE kind = ? AND model = ? AND used < ? AND length(vectors) = ? LIMIT 1`,
      kind,
      model,
      SIZE,
      SIZE * dims,
    );
    if (row) {
      const block = this.block(row.id, touched);
      // A count out of step with the slots (a hand-edited row) never overwrites a vector.
      if (block?.ids.includes(null)) return block;
    }
    const ids = new Array<string | null>(SIZE).fill(null);
    const scales = new Float32Array(SIZE);
    const vectors = new Int8Array(SIZE * dims);
    const inserted = this.db.one<{ id: number }>(
      `INSERT INTO zur_semantic_vectors (kind, model, used, ids, scales, vectors) VALUES (?, ?, 0, ?, ?, ?) RETURNING id`,
      kind,
      model,
      JSON.stringify(ids),
      scales.buffer,
      vectors.buffer,
    );
    if (!inserted) throw new Error("No block id");
    const block: Block = { id: inserted.id, kind, model, used: 0, ids, scales, vectors };
    touched.set(block.id, block);
    return block;
  }

  private free(block: Block, slot: number): void {
    if (block.ids[slot] === null || slot < 0) return;
    block.ids[slot] = null;
    block.scales[slot] = 0;
    const dims = block.vectors.length / SIZE;
    block.vectors.fill(0, slot * dims, (slot + 1) * dims);
    block.used = Math.max(0, block.used - 1);
  }

  private save(block: Block): void {
    if (block.used === 0) {
      // An empty block is derived data with nothing in it: it goes, never the owner's items.
      this.db.run(`DELETE FROM zur_semantic_vectors WHERE id = ?`, block.id);
      return;
    }
    this.db.run(
      `UPDATE zur_semantic_vectors SET used = ?, ids = ?, scales = ?, vectors = ? WHERE id = ?`,
      block.used,
      JSON.stringify(block.ids),
      block.scales.buffer as ArrayBuffer,
      block.vectors.buffer as ArrayBuffer,
      block.id,
    );
  }
}

function parseIds(json: string): (string | null)[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (Array.isArray(parsed)) return parsed.map((id) => (typeof id === "string" ? id : null));
  } catch {
    // A broken row reads as empty: its vectors are found by nobody, and are made again.
  }
  return new Array<string | null>(SIZE).fill(null);
}
