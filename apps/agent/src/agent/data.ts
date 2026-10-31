/**
 * Stored content in the prompt (rule 2 and "Prompt de sistema"): every item
 * goes in its own `<data source="…" id="…">…</data>` line. Inside, `<` and `>`
 * become `‹` and `›`, so stored text can never close the block, open another
 * one or look like markup; line breaks become spaces, so one item is one line.
 */

export const DATA_SOURCES = ["memory", "note", "task", "tool", "mcp", "telegram_forward", "calendar", "remote_event"] as const;
export type DataSource = (typeof DATA_SOURCES)[number];

/**
 * Angle brackets and their look-alikes (the marks we write, fullwidth, small
 * and math forms): stored text can't forge a tag in any of them, nor one that
 * looks like an already neutralized tag from another block.
 */
const OPENING = new Set(["<", "‹", "＜", "﹤", "〈", "⟨", "〈", "❮", "«"]);
const CLOSING = new Set([">", "›", "＞", "﹥", "〉", "⟩", "〉", "❯", "»"]);

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
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    // C0, DEL and C1 controls (line breaks included) and the Unicode line and paragraph separators: one space.
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
      space = true;
      continue;
    }
    if (code !== ZERO_WIDTH_JOINER && FORMAT.test(char)) continue;
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
