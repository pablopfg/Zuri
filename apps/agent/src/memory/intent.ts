import { fold, words } from "./text.ts";

/** Questions about how things were (pt-BR and en, over folded text). */
const PAST = words(
  "antes|anteriormente|antigamente|no passado|costumava|costumavamos|ja (?:tive|morei|trabalhei|dirigi|fui|usei)|" +
    "(?:eu )?(?:morava|dirigia|trabalhava|tinha|usava|estudava|namorava)|qual era|quais eram|onde eu (?:morava|trabalhava)|" +
    "(?:meu|minha) (?:antig[oa]|ex)|ex-|historico|era antes|" +
    "before|previous(?:ly)?|used to|formerly|former|earlier|in the past|history|historical|originally|back then|ago|anymore|" +
    "did i (?:use|have|drive|own|live|work)|what did i|where did i|was i|were my|had i|old (?:car|job|address|home|apartment|phone)",
);

/**
 * True when a question asks how things were rather than how they are. Past
 * facts reach the prompt only for such questions.
 */
export function hasHistoricalIntent(query: string): boolean {
  return PAST.test(fold(query));
}
