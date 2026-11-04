import { REVIEW_LIMITS, type ReviewGuardCode } from "@zuri/shared";
import { fold, HEALTH_WORDS, words } from "./triage.ts";

/**
 * The fixed checker of a reply (step 19c), without AI: whatever wrote it (the
 * agent, a template, the owner), a reply that fails any item never goes out.
 * Each failure is a code, kept in the audit; never the text.
 */

/** Words a public reply never carries (pt-BR and en, folded): promises and prices, health, legal matters, the machine. */
const BANNED = [
  "garantia",
  "garantimos",
  "garanto",
  "desconto",
  "descontos",
  "cupom",
  "cupons",
  "gratis",
  "reembolso",
  "devolucao",
  "indenizacao",
  "prometo",
  "prometemos",
  "processo",
  "advogado",
  "procon",
  "prompt",
  "instrucao",
  "instrucoes",
  "sistema",
  "inteligencia artificial",
  "ia",
  "modelo",
  "zuri",
  "guarantee",
  "discount",
  "coupon",
  "free",
  "refund",
  "compensation",
  "promise",
  "lawsuit",
  "lawyer",
  "instruction",
  "instructions",
  "system",
  "artificial intelligence",
  "ai",
  "model",
  ...HEALTH_WORDS,
];

const PT = new Set(["obrigado", "obrigada", "voce", "nos", "sua", "seu", "pela", "pelo", "muito", "que", "para", "com", "equipe", "ficamos", "felizes", "agradecemos", "volte", "sempre", "nao", "uma", "esperamos"]);
const EN = new Set(["thank", "thanks", "you", "your", "we", "for", "the", "and", "with", "team", "our", "very", "glad", "happy", "hope", "again", "soon", "visit", "not"]);

/** The reply's language by its common words; null when it can't tell. */
export function languageOf(text: string): "pt-BR" | "en" | null {
  let pt = 0;
  let en = 0;
  for (const word of words(text)) {
    if (PT.has(word)) pt++;
    if (EN.has(word)) en++;
  }
  if (pt === en) return null;
  return pt > en ? "pt-BR" : "en";
}

const CONTACT = /[\p{Nd}@#]|https?:|www\.|:\/\/|\b[\p{L}\p{N}-]+\.(?:com|br|net|org|io|me|app|link|ly|info|biz|xyz|site|online|store|shop)\b/iu;
const MARKUP = /[<>{}[\]`]|\*\*|__|~~|^\s*[-*+]\s|^\s*\d+[.)]\s|\]\(/mu;
const EMOJI = /\p{Extended_Pictographic}/gu;
/** Controls (line breaks aside), invisible format characters, bidi marks and variation selectors past the emoji ones. */
const HIDDEN = /[\p{Cc}\p{Cf}\u2028\u2029]|(?![\ufe0e\ufe0f])\p{Variation_Selector}/u;

export interface GuardContext {
  /** The reviewer's first name ("" when anonymous): the only person a reply may name. */
  firstName: string;
  signature: string;
  /** The owner's own banned words. */
  banned: readonly string[];
  /** The review's text: five words in a row copied from it fail. */
  comment: string;
  /** The review's language, when known; a reply in another one fails. */
  language: "pt-BR" | "en" | null;
  /** Words the owner wrote (signature, templates) a name may come from. */
  ownWords?: readonly string[];
}

/** Ends with the signature, ignoring case, accents and the final punctuation. */
export function signed(text: string, signature: string): boolean {
  const end = words(text).join(" ");
  const sign = words(signature).join(" ");
  return sign !== "" && (end === sign || end.endsWith(` ${sign}`));
}

/** The signature at the end of a reply, on its own line, unless it already ends with it. */
export function withSignature(text: string, signature: string): string {
  const trimmed = text.trim();
  return signed(trimmed, signature) ? trimmed : `${trimmed}\n\n${signature.trim()}`;
}

/** Capitalized words past a sentence's start: names, brands, places. */
function namesIn(text: string): string[] {
  const out: string[] = [];
  for (const sentence of text.split(/[.!?\n]+/u)) {
    const tokens = sentence.trim().split(/\s+/u).filter(Boolean);
    for (const [index, token] of tokens.entries()) {
      const word = token.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
      if (index > 0 && /^\p{Lu}/u.test(word)) out.push(fold(word));
    }
  }
  return out;
}

/** What fails in a reply; empty when it may go out. */
export function guard(text: string, ctx: GuardContext): ReviewGuardCode[] {
  const codes = new Set<ReviewGuardCode>();
  const chars = [...text.trim()].length;
  // 600 characters are at most 2,400 bytes: Google's 4,096-byte cap never comes into play.
  if (chars < REVIEW_LIMITS.replyMin || chars > REVIEW_LIMITS.replyMax) codes.add("size");
  if (HIDDEN.test(text.replace(/\n/g, " "))) codes.add("hidden");
  const language = languageOf(text);
  if (ctx.language && language && language !== ctx.language) codes.add("language");
  if (CONTACT.test(text)) codes.add("contact");
  if (MARKUP.test(text) || (text.match(EMOJI)?.length ?? 0) > 1) codes.add("markup");
  const allowed = new Set([...words(ctx.signature), ...(ctx.ownWords ?? []).flatMap((value) => words(value)), ...(ctx.firstName ? [fold(ctx.firstName)] : [])]);
  if (namesIn(text).some((name) => !allowed.has(name))) codes.add("name");
  if (copied(text, ctx.comment)) codes.add("copied");
  const all = ` ${words(text).join(" ")} `;
  const banned = [...BANNED, ...ctx.banned.map((word) => words(word).join(" ")).filter(Boolean)];
  // A banned word the owner's own signature carries ("Equipe Sistema Exemplo") is theirs to use.
  const signature = ` ${words(ctx.signature).join(" ")} `;
  if (banned.some((word) => all.includes(` ${word} `) && !signature.includes(` ${word} `))) codes.add("banned");
  if (!signed(text, ctx.signature)) codes.add("signature");
  return [...codes];
}

/** Five words in a row of the review in the reply. */
function copied(text: string, comment: string): boolean {
  const source = words(comment);
  if (source.length < 5) return false;
  const reply = ` ${words(text).join(" ")} `;
  for (let i = 0; i + 5 <= source.length; i++) {
    if (reply.includes(` ${source.slice(i, i + 5).join(" ")} `)) return true;
  }
  return false;
}
