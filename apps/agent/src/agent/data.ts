/**
 * Stored content in the prompt (rule 2 and "Prompt de sistema"): every item
 * goes in its own `<data source="…" id="…">…</data>` line. Inside, `<` and `>`
 * become `‹` and `›`, so stored text can never close the block, open another
 * one or look like markup; line breaks become spaces, so one item is one line.
 */

export const DATA_SOURCES = ["memory", "note", "task", "tool", "summary", "mcp", "telegram_forward", "calendar", "remote_event", "settings", "contact", "flow", "crm"] as const;
export type DataSource = (typeof DATA_SOURCES)[number];

/**
 * Angle brackets and their look-alikes (the marks we write, fullwidth, small
 * and math forms): stored text can't forge a tag in any of them, nor one that
 * looks like an already neutralized tag from another block.
 */
const OPENING = new Set(["<", "‹", "＜", "﹤", "〈", "⟨", "〈", "❮", "«", "˂", "ᐸ", "❬", "《", "⧼", "❰", "⟪", "≺", "⋖"]);
const CLOSING = new Set([">", "›", "＞", "﹥", "〉", "⟩", "〉", "❯", "»", "˃", "ᐳ", "❭", "》", "⧽", "❱", "⟫", "≻", "⋗"]);

/** The brackets written as HTML entities (`&lt;`, `&#62;`, `&#x3C;`): a model may read them as the real thing (SEC-A6-01). */
const ENTITY = /&(?:lt|gt|#0*6[02]|#x0*3[ce]);?/gi;

/**
 * Variation selectors carry no letter of their own, so a run of them can
 * smuggle hidden bytes after a visible character. Only the two that pick an
 * emoji's text or color look (U+FE0E, U+FE0F) stay (SEC-A6-02).
 */
const SMUGGLING = /(?![\ufe0e\ufe0f])\p{Variation_Selector}/u;
/** Letters that render as nothing (Hangul fillers, the blank Braille pattern): spaces (SEC-A6-02). */
const BLANK = new Set([0x115f, 0x1160, 0x3164, 0xffa0, 0x2800]);

/**
 * Invisible format characters (Unicode Cf): zero widths, bidi overrides,
 * the U+E0000 "tag" letters that smuggle hidden ASCII, interlinear marks.
 * The zero-width joiner stays, because emoji sequences need it.
 */
const FORMAT = /\p{Cf}/u;
const ZERO_WIDTH_JOINER = 0x200d;

/** Text made inert for a `<data>` block: no angle brackets, no line breaks, no control or invisible characters. */
export function neutralize(text: string): string {
  let out = "";
  let space = false;
  const decoded = text.replace(ENTITY, (entity) => (/^&(?:lt|#0*60|#x0*3c)/i.test(entity) ? "‹" : "›"));
  for (const char of decoded) {
    const code = char.codePointAt(0) ?? 0;
    // C0, DEL and C1 controls (line breaks included), the Unicode line and paragraph separators and blank letters: one space.
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 || BLANK.has(code)) {
      space = true;
      continue;
    }
    if ((code !== ZERO_WIDTH_JOINER && FORMAT.test(char)) || SMUGGLING.test(char)) continue;
    if (space && char !== " " && !out.endsWith(" ")) out += " ";
    space = false;
    out += OPENING.has(char) ? "‹" : CLOSING.has(char) ? "›" : char;
  }
  return out.trim();
}

/** Attribute values are ours (ids, sources, labels), but get the same treatment plus quotes. */
const attribute = (value: string) => neutralize(value).replace(/["'&]/g, "");

/** One item as a single `<data>` line. */
export function dataLine(source: DataSource, id: string, text: string, extra: Record<string, string> = {}): string {
  const attrs = Object.entries({ source, id, ...extra })
    .map(([key, value]) => `${key.replace(/[^a-z_]/g, "")}="${attribute(value)}"`)
    .join(" ");
  return `<data ${attrs}>${neutralize(text)}</data>`;
}
