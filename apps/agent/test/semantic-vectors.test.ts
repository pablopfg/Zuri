import { describe, expect, it } from "vitest";
import { cosine, cosineInt8, fuse, keepBest, quantize, unit } from "../src/semantic/vectors.ts";

// Step 17: the arithmetic of the search by meaning, without the database.

/** A deterministic pseudo-random generator (mulberry32), so the test is the same every run. */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A unit vector of bge-m3's size, near `base` by `noise` (0 = the same, 1 = unrelated). */
function near(base: Float32Array, noise: number, next: () => number): Float32Array {
  return unit(base.map((value) => value * (1 - noise) + (next() * 2 - 1) * noise));
}

describe("unit vectors", () => {
  it("scales to length 1 and leaves a zero or broken vector at zero", () => {
    const v = unit([3, 4]);
    expect(v[0]).toBeCloseTo(0.6);
    expect(v[1]).toBeCloseTo(0.8);
    expect([...unit([0, 0, 0])]).toEqual([0, 0, 0]);
    expect([...unit([Number.NaN, 1])]).toEqual([0, 0]);
    expect([...unit([Number.POSITIVE_INFINITY, 1])]).toEqual([0, 0]);
  });
});

describe("int8 against float32 (docs/planos/ai-gateway-hyperdrive-vectorize.md)", () => {
  it("keeps each cosine within 0.01 and the same ranking on 1,024 dimensions", () => {
    const next = random(17);
    const dims = 1_024;
    const query = unit(Float32Array.from({ length: dims }, () => next() * 2 - 1));
    // 64 vectors (one block) at every distance from the question, from almost the same to unrelated.
    const vectors = Array.from({ length: 64 }, (_, i) => near(query, i / 63, next));
    const block = new Int8Array(64 * dims);
    const scales: number[] = [];
    vectors.forEach((vector, slot) => {
      const { q, scale } = quantize(vector);
      block.set(q, slot * dims);
      scales.push(scale);
    });
    const exact = vectors.map((vector) => cosine(query, vector));
    const packed = vectors.map((_, slot) => cosineInt8(query, block, slot, scales[slot] ?? 0));
    for (let i = 0; i < 64; i++) expect(Math.abs((exact[i] ?? 0) - (packed[i] ?? 0))).toBeLessThan(0.01);
    const order = (scores: number[]) =>
      scores
        .map((score, i) => ({ score, i }))
        .sort((a, b) => b.score - a.score)
        .map((hit) => hit.i);
    // The top 10, the part a search shows, comes in the same order.
    expect(order(packed).slice(0, 10)).toEqual(order(exact).slice(0, 10));
  });

  it("maps the largest component to ±127 and a zero vector to scale 0", () => {
    const { q, scale } = quantize(unit([1, -2, 0.5]));
    expect(Math.max(...[...q].map(Math.abs))).toBe(127);
    expect(q[1]).toBe(-127);
    expect(scale).toBeGreaterThan(0);
    expect(quantize(new Float32Array(4))).toEqual({ q: new Int8Array(4), scale: 0 });
  });
});

describe("keepBest", () => {
  const floor = { absolute: 0.55, relative: 0.1 };
  it("drops hits under the floor and those too far below the best, best first, within the limit", () => {
    const hits = [0.5, 0.56, 0.7, 0.61, 0.6, 0.59].map((score, i) => ({ id: `${i}`, score }));
    expect(keepBest(hits, floor, 10).map((hit) => hit.score)).toEqual([0.7, 0.61, 0.6]);
    expect(keepBest(hits, floor, 2).map((hit) => hit.score)).toEqual([0.7, 0.61]);
    // Exactly on the floor counts; just under does not.
    expect(keepBest([{ score: 0.55 }], floor, 5)).toHaveLength(1);
    expect(keepBest([{ score: 0.5499 }], floor, 5)).toHaveLength(0);
    expect(keepBest([], floor, 5)).toEqual([]);
  });
});

describe("fuse (reciprocal rank fusion)", () => {
  it("puts what both lists found first and keeps each id once", () => {
    expect(fuse(["a", "b", "c"], ["d", "b"])).toEqual(["b", "a", "d", "c"]);
    expect(fuse(["a"], [])).toEqual(["a"]);
    expect(fuse([], ["x", "y"])).toEqual(["x", "y"]);
    expect(fuse(["a", "a"], ["a"])[0]).toBe("a");
  });
});
