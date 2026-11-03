/**
 * Characters that change how text looks without being seen: bidi controls
 * (U+202A–U+202E, U+2066–U+2069), zero-width marks, tags (U+E0000…), private
 * use, unassigned, lone surrogates and line separators. In an approval preview
 * they could make a right-to-left override before "00001" read as "10000".
 */
const HIDDEN = /[\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}]/gu;

/**
 * The arguments of an external call as the owner reads them before approving
 * (step 18b, chat card, bot, e-mail and the /aprovar page): JSON, with every
 * hidden character written as its visible `\uXXXX` escape. Still valid JSON
 * for the same value, so what is shown is what is sent; the hash stays over
 * the arguments themselves.
 */
export function visibleJson(value: unknown, indent?: number): string {
  const text = JSON.stringify(value, null, indent) ?? "null";
  return text.replace(HIDDEN, (char) => {
    let out = "";
    for (let i = 0; i < char.length; i++) out += `\\u${char.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0")}`;
    return out;
  });
}
