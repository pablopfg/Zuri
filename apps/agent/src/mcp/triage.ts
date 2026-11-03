import { MCP_LIMITS } from "@zuri/shared";
import { estimateTokens } from "../ai/provider.ts";

/**
 * Which MCP tools a turn offers the model (docs/planos/mcp.md, "Triagem por
 * turno"): no AI, words only. The free models have small windows and err more
 * with many tools, so when the tools on don't all fit in their share of the
 * prompt, the ones whose words meet the owner's message go first.
 */

export interface TriageTool {
  /** The name the model calls. */
  id: string;
  /** The server as the owner named it. */
  server: string;
  name: string;
  title: string | null;
  /** The owner's "Quando usar": weighs most. */
  hint: string;
  /** The server's text: weighs least. */
  description: string;
  /** Characters of the input schema, for the prompt's share. */
  schemaChars: number;
}

/** Words that say nothing about a tool, in both languages. */
const STOP_WORDS = new Set(
  (
    "a o os as um uma uns umas de do da dos das no na nos nas em por para pra com sem que se eu me meu minha voce vc ele ela isso esse essa este esta aqui ali e ou mas mais muito pouco ja tem ter ser estar foi " +
    "qual quais quando onde como quanto quero queria pode poderia favor ver veja diga fala liste mostre buscar busque procure procura sobre hoje amanha agora " +
    "the an of to in on for with without and or but is are was be it this that these those my me you your please can could would should show tell find search look about today now what which when where how"
  ).split(" "),
);

/** The word's stem: no accents, lower case, no plural s, the first 5 letters. */
function stem(word: string): string {
  const bare = word.length > 3 ? word.replace(/s$/, "") : word;
  return bare.slice(0, 5);
}

/** The distinct stems of a text, without stop words and words under 3 letters. */
export function stems(text: string): Set<string> {
  const words = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  const out = new Set<string>();
  for (const word of words) {
    if (word.length < 3 || STOP_WORDS.has(word)) continue;
    out.add(stem(word));
  }
  return out;
}

const hits = (wanted: Set<string>, field: Set<string>) => {
  let n = 0;
  for (const s of wanted) if (field.has(s)) n++;
  return n;
};

/** How well a tool matches the words: the hint counts 3, the names 2, the description 1. */
export function score(words: Set<string>, tool: TriageTool): number {
  if (words.size === 0) return 0;
  const names = stems(`${tool.server} ${tool.name.replace(/[_-]+/g, " ")} ${tool.title ?? ""}`);
  return 3 * hits(words, stems(tool.hint)) + 2 * hits(words, names) + hits(words, stems(tool.description));
}

/** The prompt tokens one tool takes when offered: name, the description the model reads, schema and a margin. */
export function toolCost(tool: TriageTool): number {
  return estimateTokens(tool.id.length + Math.min(tool.description.length, MCP_LIMITS.descriptionMax) + tool.hint.length + tool.schemaChars + 120);
}

export interface Triage {
  /** The tools offered in this turn, by id. */
  offered: string[];
  /** Tools on but not offered: find_tools is offered when there are any. */
  leftOut: number;
}

/**
 * The tools a turn offers. All of them when they fit in the share and the
 * count; otherwise the ones used in the last messages first, then by score
 * (only those that match at all), in half the count and half the share, so
 * find_tools has the other half.
 */
export function triage(message: string, tools: readonly TriageTool[], recent: ReadonlySet<string> = new Set()): Triage {
  const total = tools.reduce((n, tool) => n + toolCost(tool), 0);
  if (tools.length <= MCP_LIMITS.maxOfferedTools && total <= MCP_LIMITS.offeredTokens) return { offered: tools.map((tool) => tool.id), leftOut: 0 };
  const words = stems(message);
  const ranked = tools
    .map((tool, index) => ({ tool, index, score: score(words, tool), recent: recent.has(tool.id) }))
    .filter((item) => item.recent || item.score > 0)
    .sort((a, b) => Number(b.recent) - Number(a.recent) || b.score - a.score || a.index - b.index);
  // Half the slots and half the share: the other half is for what find_tools brings in this turn.
  const slots = Math.floor(MCP_LIMITS.maxOfferedTools / 2);
  const share = MCP_LIMITS.offeredTokens / 2;
  const offered: string[] = [];
  let spent = 0;
  for (const { tool } of ranked) {
    if (offered.length >= slots) break;
    const cost = toolCost(tool);
    if (spent + cost > share) continue;
    offered.push(tool.id);
    spent += cost;
  }
  return { offered, leftOut: tools.length - offered.length };
}

/** find_tools: the tools on whose words meet the phrase, best first, at most MCP_LIMITS.findResults. */
export function findTools(query: string, tools: readonly TriageTool[]): TriageTool[] {
  const words = stems(query);
  return tools
    .map((tool, index) => ({ tool, index, score: score(words, tool) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, MCP_LIMITS.findResults)
    .map((item) => item.tool);
}
