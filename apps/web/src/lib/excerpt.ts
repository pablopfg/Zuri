/**
 * The start of a note as one line of text for the list: Markdown marks (#, -,
 * [ ], >, **, `, links, images, HTML tags) are only noise there. Single * and _ stay, since they are
 * often part of the text (nome_do_arquivo).
 */
export function plainExcerpt(markdown: string): string {
  return markdown
    .replace(/^\s*(#{1,6}|[-*+]|\d+\.|>)\s+/gm, "")
    .replace(/^\[[ xX]\]\s+/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/\*\*|__|`|~~/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
