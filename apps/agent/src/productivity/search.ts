/** Search helpers shared by tasks (LIKE) and notes (FTS5). Nothing typed by the owner is ever SQL. */

/**
 * A LIKE pattern that matches `query` literally anywhere in the text, for use
 * with `ESCAPE '\'`: the owner's %, _ and \ are just characters.
 */
export function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Words too common to narrow a search (pt-BR and en). */
const STOPWORDS = new Set(
  (
    "a o as os um uma uns umas de da do das dos em na no nas nos e ou que com por para pra se ao aos à às é" +
    " the an and or of to in on at for with is are be by it this that"
  ).split(" "),
);

const MAX_TERMS = 8;

/** The words of a search, lower-cased and in NFC, without the common ones, at most 8. */
export function searchTerms(query: string): string[] {
  const words = query.normalize("NFC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const kept = words.filter((word) => word.length >= 2 && !STOPWORDS.has(word));
  return [...new Set(kept)].slice(0, MAX_TERMS);
}

/**
 * A safe FTS5 MATCH expression: every word quoted, as a prefix, all required.
 * Quotes, operators (AND, OR, NOT, NEAR), column filters, ^ and * typed by the
 * owner never reach FTS5 as syntax: only letters and digits survive, inside
 * quotes. Null when nothing searchable is left (then the caller uses LIKE).
 */
export function ftsQuery(query: string): string | null {
  const terms = searchTerms(query);
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term}"*`).join(" ");
}
