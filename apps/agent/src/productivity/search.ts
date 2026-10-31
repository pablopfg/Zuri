/** Search helpers shared by tasks (instr) and notes (FTS5). Nothing typed by the owner is ever SQL. */

/**
 * The search text folded the way SQLite's lower() folds a column: ASCII only.
 * Compared with `instr(lower(col), ?)`, it matches like LIKE did (A–Z ignore
 * case, everything else exact), and %, _ and \ are plain characters. LIKE is
 * out because the platform caps a LIKE pattern at 50 bytes.
 */
export function asciiLower(query: string): string {
  return query.replace(/[A-Z]/g, (c) => c.toLowerCase());
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
 * quotes. Null when nothing searchable is left (then the caller looks for the text literally with instr).
 */
export function ftsQuery(query: string): string | null {
  const terms = searchTerms(query);
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term}"*`).join(" ");
}
