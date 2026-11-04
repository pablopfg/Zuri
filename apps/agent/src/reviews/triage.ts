import type { ReviewReason } from "@zuri/shared";
import { REVIEW_LIMITS } from "@zuri/shared";

/**
 * The triage of a review (step 19c), without AI: the rating decides first and
 * the words can only make it more cautious. 1 to 3 stars (and a rating Google
 * didn't give) always go to the team; a 4 or 5 goes to the team too when its
 * text looks like a command, carries a link or a contact, complains or speaks
 * of health. Pure functions: the same text always gets the same answer.
 */

const STARS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

/** Google's star rating as a number; 0 for STAR_RATING_UNSPECIFIED or anything else. */
export function ratingOf(star: string | undefined): number {
  return (star && STARS[star]) || 0;
}

/** Lower case, without accents or marks: "Péssimo" and "pessimo" are the same word. */
export function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
}

/** The words of a text, folded. */
export function words(text: string): string[] {
  return fold(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** " a b c ": the words joined, to find a phrase of whole words. */
const joined = (text: string) => ` ${words(text).join(" ")} `;

const has = (text: string, list: readonly string[]) => {
  const all = joined(text);
  return list.some((entry) => all.includes(` ${entry} `));
};

/**
 * Only the first name, at most 20 letters (no digits, no marks of a handle);
 * empty for an anonymous reviewer or a name that isn't one.
 */
export function firstName(displayName: string | undefined, anonymous: boolean | undefined): string {
  if (anonymous || !displayName) return "";
  const first = displayName.trim().split(/\s+/)[0] ?? "";
  const letters = first.replace(/[^\p{L}'-]/gu, "");
  if (!letters || letters.length !== first.length || [...letters].length > REVIEW_LIMITS.firstNameMax) return "";
  return letters;
}

/** Words that read as orders to whoever writes the reply (pt-BR and en), folded. */
const COMMANDS = [
  "ignore",
  "ignora",
  "ignorar",
  "ignorem",
  "responda",
  "responde",
  "responder com",
  "reply with",
  "respond with",
  "instrucao",
  "instrucoes",
  "instruction",
  "instructions",
  "sistema",
  "system",
  "assistente",
  "assistant",
  "diga que",
  "diga",
  "say that",
  "escreva",
  "write",
  "prompt",
  "ia",
  "ai",
  "chatgpt",
  "modelo",
  "model",
];

/** Words of a complaint: a good rating with one of these goes to the team. */
const COMPLAINTS = [
  "demora",
  "demorou",
  "demorado",
  "demorada",
  "atraso",
  "atrasou",
  "atrasado",
  "atrasada",
  "caro",
  "cara demais",
  "ruim",
  "pessimo",
  "pessima",
  "horrivel",
  "nao gostei",
  "nao recomendo",
  "cobranca",
  "cobraram",
  "grosseiro",
  "grosseira",
  "grosso",
  "grossa",
  "sujo",
  "suja",
  "reclamacao",
  "reclamar",
  "decepcao",
  "decepcionado",
  "decepcionada",
  "infelizmente",
  "porem",
  "slow",
  "delay",
  "delayed",
  "late",
  "expensive",
  "overpriced",
  "bad",
  "terrible",
  "awful",
  "rude",
  "dirty",
  "complaint",
  "disappointed",
  "disappointing",
  "unfortunately",
  "however",
  "poor",
];

/**
 * Health and the bond with a client: a public reply must never confirm that
 * someone is a client of a health service (LGPD, sensitive data).
 */
export const HEALTH_WORDS = [
  "diagnostico",
  "tratamento",
  "dieta",
  "peso",
  "exame",
  "exames",
  "remedio",
  "remedios",
  "medicamento",
  "medicamentos",
  "paciente",
  "pacientes",
  "consulta",
  "consultas",
  "prontuario",
  "resultado",
  "resultados",
  "diagnosis",
  "treatment",
  "diet",
  "weight",
  "exam",
  "exams",
  "medicine",
  "medication",
  "patient",
  "patients",
  "appointment",
  "result",
  "results",
];

const URL_LIKE = /(?:https?:|www\.|:\/\/|\b[\p{L}\p{N}-]+\.(?:com|br|net|org|io|me|app|link|ly|info|biz|xyz|site|online|store|shop)\b)/iu;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
/** Eight digits or more, with the usual separators between them: a phone or a document. */
const PHONE = /(?:\d[\s().-]*){8,}/;
const TAG = /<\s*\/?\s*[a-z!]|<\/|&lt;|&#0*60/i;
const REPEAT = /(.)\1{20,}/su;

/** Signs of a message meant for the machine, not for the business. Any one sends the review to the team, without a draft. */
export function suspicious(comment: string): boolean {
  if ([...comment].length > REVIEW_LIMITS.commentForAi) return true;
  if (TAG.test(comment) || URL_LIKE.test(comment) || EMAIL.test(comment) || PHONE.test(comment) || REPEAT.test(comment)) return true;
  if (has(comment, COMMANDS)) return true;
  const letters = [...comment].filter((char) => /\p{L}/u.test(char));
  if (letters.length >= 10) {
    const foreign = letters.filter((char) => !/\p{Script=Latin}/u.test(char)).length;
    if (foreign / letters.length > 0.3) return true;
  }
  return false;
}

export function complaint(comment: string): boolean {
  return has(comment, COMPLAINTS);
}

export function health(comment: string): boolean {
  return has(comment, HEALTH_WORDS);
}

/** The team or a positive reply, and why. Never asks the AI: that comes after, and only for positives. */
export function triage(review: { rating: number; comment: string }): { route: "team" | "positive"; reasons: ReviewReason[] } {
  const reasons: ReviewReason[] = [];
  if (review.rating < 4) reasons.push("low_rating");
  const text = review.comment.trim();
  if (text) {
    if (suspicious(text)) reasons.push("suspicious");
    else {
      if (complaint(text)) reasons.push("complaint");
      if (health(text)) reasons.push("health");
    }
  }
  return { route: reasons.length ? "team" : "positive", reasons };
}
