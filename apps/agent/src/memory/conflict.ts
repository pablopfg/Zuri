import type { MemoryReviewReason, MemoryReviewRelationship, MemoryTopic } from "@zuri/shared";
import { fold, tokens, words } from "./text.ts";

/**
 * Deterministic rules (no AI) for how a new fact relates to an older one.
 * Rules only ever raise a review: they never retire a memory on their own.
 * All patterns run over folded text (lower case, no accents), in pt-BR and en.
 */

export type Relationship = "duplicate" | "supersedes" | "refines" | "contradicts" | "possible_update" | "complements" | "unrelated";

export interface Assessment {
  relationship: Relationship;
  reason: MemoryReviewReason | null;
  topic: MemoryTopic | null;
}

/** A topic where a person normally has one value at a time, and the wording that says the old value ended. */
interface Topic {
  name: MemoryTopic;
  /** FTS terms for finding older memories on this topic without shared words. */
  keywords: string;
  about: RegExp;
  change: RegExp;
}

/** "Temporarily", "for a week": a trip, not a change of address. */
const TEMPORARY = words(
  "temporariamente|por (?:uma|um|alguns|algumas|duas|dois|tres) (?:semana|semanas|mes|meses|dia|dias|fim de semana)|de ferias|temporarily|for (?:a|the) (?:week|weekend|month|trip)",
);

export const TOPICS: readonly Topic[] = [
  {
    name: "residence",
    keywords: "moro mora morar morando resido reside endereco mudei mudou live lives living reside based moved relocated address",
    about: words(
      "moro|mora|moramos|morar|morando|morei|resido|reside|residencia|endereco|(?:me )?mudei|mudamos|mudou|live[sd]?|living|reside[sd]?|based in|moved|relocated|address",
    ),
    change: words("(?:me )?mudei|mudamos|nao moro mais|deixei de morar|moved|relocated|no longer live|don'?t live"),
  },
  {
    name: "vehicle",
    keywords: "carro dirijo dirigir veiculo moto tesla volkswagen fusca fiat chevrolet bmw toyota honda ford car drive vehicle truck",
    about: words(
      "carro|carros|dirijo|dirigir|dirigia|veiculo|moto|caminhonete|car|cars|drive[sn]?|driving|vehicle|truck|tesla|volkswagen|vw|fusca|gol|fiat|chevrolet|hyundai|renault|bmw|toyota|honda|ford|audi|mercedes|jeep|byd",
    ),
    change: words(
      "vendi|troquei|substitui|me desfiz|nao tenho mais|nao dirijo mais|sold|traded|trade[ds]? in|replaced|got rid of|no longer (?:drive|own|have)",
    ),
  },
  {
    name: "job",
    keywords: "trabalho trabalha emprego empresa cargo work works job employer employed position role",
    about: words(
      "trabalh(?:o|a|ar|amos|ava|ei) (?:na|no|em|como|para|pra)|emprego|empregad[oa]|cargo|work(?:s|ing)? (?:at|for|as)|job|employer|employed|position at|role at",
    ),
    change: words(
      "novo emprego|pedi demissao|sai d[oa]|sai da empresa|fui demitid[oa]|me aposentei|comecei a trabalhar|entrei n[ao]|nao trabalho mais|new job|quit|left (?:my|the) job|started (?:a new job|working)|joined|switched jobs|was laid off|retired|no longer work",
    ),
  },
  {
    name: "diet",
    keywords: "vegetariano vegetariana vegano vegana carne gluten lactose cetogenica vegetarian vegan pescatarian keto meat",
    about: words(
      "vegetarian[oa]|vegan[oa]|pescetarian[oa]|como carne|comer carne|sem gluten|sem lactose|cetogenica|low carb|vegetarian|vegan|pescatarian|keto|eat(?:s)? meat|gluten[- ]free",
    ),
    change: words(
      "nao sou mais|deixei de|virei|parei de comer|voltei a comer|passei a|no longer|not anymore|stopped being|stopped eating|became|gave up|switched to",
    ),
  },
  {
    name: "relationship",
    keywords: "casado casada solteiro solteira divorciado divorciada namorado namorada noivo noiva esposa marido married single divorced partner wife husband",
    about: words(
      "casad[oa]|solteir[oa]|divorciad[oa]|(?:me |nos )?(?:divorciei|divorciamos|separei|separamos|casei|casamos)|terminei o namoro|terminamos|separad[oa]|namorad[oa]|namorando|noiv[oa]|esposa|marido|companheir[oa]|married|single|divorced|partner|wife|husband|boyfriend|girlfriend|engaged|dating",
    ),
    change: words(
      "me divorciei|nos divorciamos|terminei|terminamos|me separei|nos separamos|me casei|nos casamos|casei|fiquei noiv[oa]|nao sou mais casad[oa]|divorced|broke up|separated|got married|got engaged|no longer (?:married|dating|with)",
    ),
  },
];

/** FTS terms for the one-value topics a fact is about (to find candidates that share no word). */
export function topicSearchTerms(text: string): string[] {
  const folded = fold(text);
  return TOPICS.filter((topic) => topic.about.test(folded)).map((topic) => topic.keywords);
}

/** Wording that says something stopped being true. */
const EXPLICIT_CHANGE = words(
  "nao [\\p{L} ]{0,30}mais|deixei de|em vez de|no lugar de|substitui|troquei|mudei|parei de|larguei|vendi|me desfiz|desisti de|abandonei" +
    "|no longer|not anymore|anymore|used to|instead of|replaced|switched|changed|stopped|quit|sold|traded|got rid of|moved (?:from|away|out)|gave up",
);

const changes = (topic: Topic, folded: string) => topic.change.test(folded) && !TEMPORARY.test(folded);

/**
 * How `newer` relates to `older`. Similarity alone never means "replaces": it
 * takes change wording that names the old fact (by its words or its topic), or
 * a strict refinement (every meaningful word of the old one plus more).
 */
export function classify(newer: string, older: string): Assessment {
  const a = fold(newer);
  const b = fold(older);
  if (a === b) return { relationship: "duplicate", reason: null, topic: null };

  const newTokens = tokens(newer);
  const oldTokens = tokens(older);
  const shared = [...oldTokens].filter((token) => newTokens.has(token));
  const explicitChange = EXPLICIT_CHANGE.test(a);
  const topic = TOPICS.find((t) => t.about.test(a) && t.about.test(b));

  // 1. The new fact names the old one and says it changed: "Vendi meu Volkswagen…".
  //    The shared words cover at least half of what the old fact is about.
  if (explicitChange && shared.length > 0 && shared.length * 2 >= oldTokens.size) {
    return { relationship: "supersedes", reason: "explicit_change", topic: topic?.name ?? null };
  }

  // 2. The same one-value topic.
  if (topic) {
    if (changes(topic, a) && !changes(topic, b)) return { relationship: "supersedes", reason: "topic_change", topic: topic.name };
    if (oldTokens.size > 0 && shared.length === oldTokens.size && newTokens.size > oldTokens.size) {
      return { relationship: "refines", reason: "refines", topic: topic.name };
    }
    return {
      relationship: changes(topic, a) ? "possible_update" : "contradicts",
      reason: changes(topic, a) ? "topic_change" : "same_topic",
      topic: topic.name,
    };
  }

  // 3. Strict refinement: every meaningful word of the old fact, plus detail.
  if (oldTokens.size >= 2 && shared.length === oldTokens.size && newTokens.size > oldTokens.size) {
    return { relationship: "refines", reason: "refines", topic: null };
  }

  if (shared.length > 0) return { relationship: "complements", reason: null, topic: null };
  return { relationship: "unrelated", reason: null, topic: null };
}

/** The review a relationship asks for, or null. Rules never retire a memory: replacements wait for the owner. */
export function reviewFor(assessment: Assessment): { relationship: MemoryReviewRelationship; reason: MemoryReviewReason } | null {
  switch (assessment.relationship) {
    case "supersedes":
    case "refines":
    case "possible_update":
      return { relationship: "possible_update", reason: assessment.reason ?? "explicit_change" };
    case "contradicts":
      return { relationship: "contradiction", reason: assessment.reason ?? "same_topic" };
    default:
      return null;
  }
}
