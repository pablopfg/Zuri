import { fold, words } from "./text.ts";

/**
 * Questions about how things were (pt-BR and en, over folded text). "Antes da
 * reunião" and "before the meeting" are about now: "antes" and "before" count
 * only when nothing they point to follows. "Tinha" and "usava" count only with
 * "eu" ("tinha reunião hoje?" is about today).
 */
const PAST = words(
  "antes(?! (?:de|da|do|das|dos|que|disso)(?![\\p{L}\\p{N}]))|anteriormente|antigamente|no passado|costumava|costumavamos|ja (?:tive|morei|trabalhei|dirigi|fui|usei)|" +
    "(?:eu )?(?:morava|dirigia|trabalhava|estudava|namorava)|eu (?:tinha|usava)|qual era|quais eram|onde eu (?:morava|trabalhava)|" +
    "(?:meu|minha) (?:antig[oa]|ex)|ex-|era antes|" +
    "before(?! (?:the|a|an|my|your|our|i|we|you|it|this|that|going|leaving|lunch|dinner|bed|work)(?![\\p{L}\\p{N}]))|previous(?:ly)?|used to|formerly|former|in the past|originally|back then|ago|anymore|" +
    "did i (?:use|have|drive|own|live|work)|what did i|where did i|was i|were my|had i|old (?:car|job|address|home|apartment|phone)",
);

/**
 * True when a question asks how things were rather than how they are. Past
 * facts reach the prompt only for such questions.
 */
export function hasHistoricalIntent(query: string): boolean {
  return PAST.test(fold(query));
}
