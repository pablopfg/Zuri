/** Removes HTML tags until none is left, so a nested "<<b>b>" can't rebuild one. */
function withoutTags(text: string): string {
  let current = text;
  let previous: string;
  do {
    previous = current;
    current = current.replace(/<[^<>]*>/g, "");
  } while (current !== previous);
  // A < or > that never closed a tag is noise too.
  return current.replace(/[<>]/g, "");
}

/**
 * The start of a note as one line of text for the list: Markdown marks (#, -,
 * [ ], >, **, `, links, images, HTML tags) are only noise there. Single * and
 * _ stay, since they are often part of the text (nome_do_arquivo). The excerpt
 * is shown as text, never as HTML.
 */
export function plainExcerpt(markdown: string): string {
  const text = markdown
    .replace(/^\s*(#{1,6}|[-*+]|\d+\.|>)\s+/gm, "")
    .replace(/^\[[ xX]\]\s+/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");
  return withoutTags(text)
    .replace(/\*\*|__|`|~~/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
