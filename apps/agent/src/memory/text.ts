/**
 * Text helpers for memories: folding, the meaningful words of a fact and the
 * duplicate key. Rules match folded text (lower case, no accents), so
 * "não moro mais" and "nao moro mais" are the same sentence.
 */

/**
 * Lower case, Latin accents removed, spaces collapsed. Only the combining
 * diacritics block (U+0300–U+036F) goes: marks that change a word in other
 * scripts stay (Japanese dakuten, Devanagari vowel signs), so "ハート" and
 * "バート" never fold into the same fact.
 */
export function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]+/g, "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A regular expression for whole words or phrases over folded text. JavaScript's
 * \b only knows ASCII, so word edges are letters and digits of any script.
 */
export function words(source: string, flags = ""): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${source})(?![\\p{L}\\p{N}])`, `u${flags}`);
}

/** Words too common to say what a fact is about (pt-BR and en, folded). */
const STOP = new Set(
  (
    // pt-BR
    "a o as os um uma uns umas de da do das dos em na no nas nos e ou que com por para pra se ao aos eu meu minha meus minhas" +
    " me mim voce ele ela eles elas seu sua seus suas nosso nossa isso isto esse essa este esta aquele aquela ja mais muito" +
    " muita pouco agora ainda tambem so sou estou esta era foi ser estar tem tenho tinha ter fazer faz fiz como quando onde" +
    " porque qual quais quem nao sim bem mas entao la aqui hoje sempre nunca todo toda todos todas cada outro outra" +
    " sobre sob entre ate apos desde contra sem pelo pela pelos pelas num numa dum duma lhe lhes nos vos" +
    // en
    " the an and are as at be but by can could do does did for from had has have how i i'm im if in into is it its me my of" +
    " on or our so than that the their them then there these they this to us was we were what when where which who why will" +
    " with would you your about also just like now new very really still been being am he she his her owner user"
  ).split(" "),
);

/** Common words that never identify the subject of a fact. */
const GENERIC = new Set(
  (
    "gosto gosta adoro ama amo prefiro prefere bom boa melhor favorito favorita coisa coisas dia dias ano anos semana" +
    " semanas mes meses vez vezes quero preciso usar uso usa" +
    " like likes love loves enjoy enjoys prefer prefers good great best favorite favourite thing things day days year years" +
    " week weeks month months always never usually often want need use used"
  ).split(" "),
);

/**
 * The meaningful words of a fact, folded, without common words, with a crude
 * plural cut ("carros" and "carro" match).
 */
export function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of fold(text).match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (raw.length < 3 || STOP.has(raw) || GENERIC.has(raw)) continue;
    out.add(raw.length > 4 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw);
  }
  return out;
}

/** At most this many words go to a candidate search. */
const MAX_SEARCH_TERMS = 12;

/**
 * An FTS5 MATCH that finds any of the words (OR), each quoted as a prefix: the
 * owner's text never reaches FTS5 as syntax. Null when no word is left.
 */
export function anyWordQuery(text: string): string | null {
  const terms = [...tokens(text)].slice(0, MAX_SEARCH_TERMS);
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term}"*`).join(" OR ");
}

/**
 * The duplicate key: a 53-bit hash (cyrb53) of the folded text. Equal keys are
 * compared by their folded text, so a collision never merges two facts.
 */
export function dedupeKey(text: string): number {
  const folded = fold(text);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < folded.length; i++) {
    const code = folded.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
