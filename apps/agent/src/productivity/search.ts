/** Search helpers shared by tasks (instr) and notes (FTS5). Nothing typed by the owner is ever SQL. */

/** Capitals SQLite's lower() leaves alone that pt-BR (and es, fr, de) text uses, with their small letters. */
const LATIN_CAPITALS = "ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞ";
const LATIN_SMALL = "àáâãäåæçèéêëìíîïðñòóôõöøùúûüýþ";

/**
 * A column folded for a literal search: SQLite's lower() (A–Z only) over the
 * column with the accented Latin capitals made small first, so "Água" matches
 * "água". Built from constants only; no text typed by the owner is in it.
 */
export function foldedColumn(column: string): string {
  let sql = column;
  for (let i = 0; i < LATIN_CAPITALS.length; i++) sql = `replace(${sql}, '${LATIN_CAPITALS[i]}', '${LATIN_SMALL[i]}')`;
  return `lower(${sql})`;
}

/**
 * The search text folded exactly as foldedColumn folds a column, in NFC (the
 * form stored text is kept in). Compared with `instr(<folded column>, ?)`, %, _
 * and \ are plain characters. LIKE is out because the platform caps a LIKE
 * pattern at 50 bytes (CF-6-01).
 */
export function foldSearch(query: string): string {
  return query.normalize("NFC").replace(/[A-Z\u00c0-\u00de]/g, (c) => {
    const at = LATIN_CAPITALS.indexOf(c);
    return at >= 0 ? (LATIN_SMALL[at] ?? c) : c.toLowerCase();
  });
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
