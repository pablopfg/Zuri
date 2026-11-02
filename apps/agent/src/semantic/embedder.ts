import { EMBEDDING_MODEL } from "@zuri/shared";
import { classifyAiError } from "../ai/provider.ts";
import { searchTerms } from "../productivity/search.ts";
import { unit } from "./vectors.ts";

/**
 * Text to vectors. Only two exist: Workers AI on the owner's own account, and
 * the mock of local development and the tests. Never a chat provider, and
 * never one outside the account: the index reads everything the owner keeps
 * (D8, docs/planos/troca-de-provedores-e-protecao-de-dados.md).
 */
export interface Embedder {
  readonly model: string;
  readonly dims: number;
  readonly billable: boolean;
  /** What counts as a match for this model: the cosine floor and how far below the best a hit may be. */
  readonly floor: { absolute: number; relative: number };
  /** One unit vector per text, in order. */
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
}

/** bge-m3's vectors: 1,024 dimensions. */
export const BGE_M3_DIMS = 1_024;

/**
 * bge-m3's floors, as measured with real sentences in the reference project
 * (Talorys, docs/semantic-recall.md): right answers sit above 0.55, and a hit
 * more than 0.10 under the best one is noise.
 */
export const BGE_M3_FLOOR = { absolute: 0.55, relative: 0.1 } as const;

/** bge-m3 on the owner's Workers AI, through the AI binding. */
export class WorkersAIEmbedder implements Embedder {
  readonly model = EMBEDDING_MODEL;
  readonly dims = BGE_M3_DIMS;
  readonly billable = true;
  readonly floor = BGE_M3_FLOOR;

  constructor(private readonly binding: Ai) {}

  async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    let result: { data?: unknown };
    try {
      result = (await this.binding.run(
        this.model as Parameters<Ai["run"]>[0],
        // A text past the model's window is cut, never refused: the index takes the start.
        { text: texts, truncate_inputs: true } as never,
        signal ? ({ signal } as never) : undefined,
      )) as { data?: unknown };
    } catch (error) {
      throw classifyAiError(error);
    }
    const data = result?.data;
    if (!Array.isArray(data) || data.length !== texts.length) throw classifyAiError(new Error("Malformed embedding response"));
    return data.map((row: unknown) => {
      if (!Array.isArray(row) || row.length !== this.dims || !row.every((value) => typeof value === "number" && Number.isFinite(value))) {
        throw classifyAiError(new Error("Malformed embedding vector"));
      }
      return unit(row as number[]);
    });
  }
}

/** Words the mock treats as one idea, so "carro" lands next to "automóvel" (the acceptance test). */
const MOCK_CONCEPTS: readonly (readonly string[])[] = [
  ["carro", "automovel", "veiculo", "car", "automobile", "vehicle"],
  ["medico", "doutor", "consulta", "doctor", "physician", "appointment"],
  ["cachorro", "cao", "cachorrinho", "dog", "puppy"],
  ["mercado", "supermercado", "compras", "groceries", "market"],
  ["aniversario", "birthday"],
  ["remedio", "medicamento", "medicine", "medication"],
  ["viagem", "viajar", "ferias", "trip", "travel", "vacation"],
];

const plain = (word: string) => word.normalize("NFD").replace(/\p{Diacritic}/gu, "");

const CONCEPT_OF = new Map<string, string>();
for (const group of MOCK_CONCEPTS) for (const word of group) CONCEPT_OF.set(word, group[0] as string);

/** 32-bit FNV-1a: the same word always lands on the same dimension. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    h ^= byte;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The stand-in for local development and the tests: a bag of words hashed into
 * 256 dimensions, with the synonym groups above as one word each. Deterministic,
 * free, and never a network call.
 */
export class MockEmbedder implements Embedder {
  readonly model = "mock-embedding";
  readonly dims = 256;
  readonly billable = false;
  readonly floor = { absolute: 0.3, relative: 0.3 } as const;
  /** Texts embedded so far, for the tests (one entry per call). */
  readonly calls: string[][] = [];

  async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    signal?.throwIfAborted();
    this.calls.push([...texts]);
    return texts.map((text) => this.vector(text));
  }

  private vector(text: string): Float32Array {
    const out = new Float32Array(this.dims);
    for (const term of searchTerms(text)) {
      const word = plain(term);
      const feature = CONCEPT_OF.get(word) ?? word;
      const h = hash(feature);
      out[h % this.dims] = (out[h % this.dims] ?? 0) + (h & 0x8000_0000 ? -1 : 1);
    }
    return unit(out);
  }
}
