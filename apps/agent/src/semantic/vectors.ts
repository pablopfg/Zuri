/**
 * Vector arithmetic of the search by meaning (step 17), without the database.
 *
 * Vectors are stored at unit length and quantized to int8 with one scale per
 * vector (1 KB each for bge-m3's 1,024 dimensions instead of 4 KB in float32),
 * packed SEMANTIC_LIMITS.blockSize to a row: a search reads one row per block,
 * never one per vector (docs/planos/ai-gateway-hyperdrive-vectorize.md).
 */

/** The vector at unit length; a zero (or broken) vector stays zero, so it matches nothing. */
export function unit(vector: ArrayLike<number>): Float32Array {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) {
    const value = vector[i] ?? 0;
    sum += value * value;
  }
  const out = new Float32Array(vector.length);
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm === 0) return out;
  for (let i = 0; i < vector.length; i++) out[i] = (vector[i] ?? 0) / norm;
  return out;
}

/**
 * A unit vector as int8 and its scale: value ≈ q × scale. The largest
 * component maps to ±127, so no component is clipped.
 */
export function quantize(vector: Float32Array): { q: Int8Array; scale: number } {
  let max = 0;
  for (const value of vector) max = Math.max(max, Math.abs(value));
  const q = new Int8Array(vector.length);
  if (max === 0) return { q, scale: 0 };
  const scale = max / 127;
  for (let i = 0; i < vector.length; i++) q[i] = Math.round((vector[i] ?? 0) / scale);
  return { q, scale };
}

/** The cosine of a unit query and a unit float32 vector: their dot product. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

/**
 * The cosine of a unit query with the quantized vector at `slot` of a block:
 * the dot product with the int8 values, times the vector's scale.
 */
export function cosineInt8(query: Float32Array, block: Int8Array, slot: number, scale: number): number {
  const dims = query.length;
  const start = slot * dims;
  let dot = 0;
  for (let i = 0; i < dims; i++) dot += (query[i] as number) * (block[start + i] as number);
  return dot * scale;
}

/**
 * The hits worth showing: at or above the absolute floor and no further than
 * `relative` below the best one, best first, at most `limit`.
 */
export function keepBest<T extends { score: number }>(hits: T[], floor: { absolute: number; relative: number }, limit: number): T[] {
  const sorted = hits.filter((hit) => hit.score >= floor.absolute).sort((a, b) => b.score - a.score);
  const best = sorted[0]?.score ?? 0;
  return sorted.filter((hit) => hit.score >= best - floor.relative).slice(0, limit);
}

/** Reciprocal rank fusion's constant: the usual 60 keeps one list from drowning the other. */
const RRF_K = 60;

/**
 * Keyword and meaning results as one list (reciprocal rank fusion): an item
 * found both ways comes first; then each list's leaders, alternately. Ids are
 * kept once, in the fused order.
 */
export function fuse(...lists: string[][]): string[] {
  const score = new Map<string, number>();
  for (const list of lists) {
    for (const [rank, id] of list.entries()) score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}
