import { MCP_TOOL_KINDS, type McpToolKind } from "@zuri/shared";
import { parseHints } from "./catalog.ts";

/**
 * What a tool does, as Zuri judges it (decision of 03/11/2026): the server's
 * marks are third-party text and never decide on their own. A fixed rule over
 * the tool's name, title, description and input fields, with no model call:
 * a description written to talk a model into something has nothing to talk
 * to here. Any doubt goes to the more dangerous kind, and the server's marks
 * can only make a tool more careful, never less. The owner confirms the kind
 * on the tool's card.
 */

/** Words that delete, overwrite or undo something for good. */
const DESTRUCTIVE = [
  "delete", "remove", "erase", "destroy", "drop", "purge", "wipe", "truncate", "overwrite", "replace", "reset", "revoke", "cancel", "terminate", "kill", "unsubscribe", "uninstall", "archive", "discard",
  "apagar", "apaga", "excluir", "exclui", "remover", "remove", "deletar", "destruir", "limpar", "sobrescrever", "substituir", "cancelar", "cancela", "revogar", "zerar", "descartar", "arquivar", "desinstalar",
];

/** Words that create or change something, or send it somewhere. */
const WRITE = [
  "create", "add", "insert", "update", "edit", "modify", "set", "put", "post", "send", "write", "upload", "move", "rename", "assign", "schedule", "book", "publish", "submit", "invite", "share", "reply", "comment", "approve", "close", "open", "start", "stop", "run", "execute", "trigger", "pay", "transfer", "merge", "push", "save", "change", "patch", "upsert", "import", "sync", "mark", "enable", "disable",
  "criar", "cria", "adicionar", "adiciona", "inserir", "atualizar", "atualiza", "editar", "alterar", "altera", "mudar", "enviar", "envia", "mandar", "manda", "escrever", "subir", "mover", "renomear", "agendar", "agenda", "marcar", "publicar", "convidar", "compartilhar", "responder", "comentar", "aprovar", "fechar", "abrir", "iniciar", "parar", "executar", "pagar", "transferir", "salvar", "registrar", "cadastrar", "importar", "sincronizar", "ligar", "desligar",
];

/** Words that only look things up. A tool is "read" only with one of these in its name and nothing else anywhere. */
const READ = [
  "get", "list", "search", "find", "read", "fetch", "lookup", "query", "show", "view", "describe", "count", "check", "status", "info", "browse", "retrieve", "preview", "inspect", "summarize",
  "buscar", "busca", "listar", "lista", "procurar", "procura", "ler", "le", "consultar", "consulta", "ver", "mostrar", "obter", "pesquisar", "pesquisa", "contar", "conferir",
];

const DESTRUCTIVE_SET = new Set(DESTRUCTIVE);
const WRITE_SET = new Set(WRITE);
const READ_SET = new Set(READ);

const RANK: Record<McpToolKind, number> = { read: 0, write: 1, destructive: 2 };
export const kindRank = (kind: McpToolKind) => RANK[kind];
export const moreCareful = (a: McpToolKind, b: McpToolKind): McpToolKind => (RANK[a] >= RANK[b] ? a : b);

/** Why the kind was chosen, for the card: where the word was found, or that the server marks it, or that nothing was known. */
export type KindReason = { source: "name" | "description" | "fields"; word: string } | { source: "server" } | { source: "unknown" };

export interface Classification {
  kind: McpToolKind;
  reason: KindReason;
}

/** Lower-case words of a text, splitting snake_case, kebab-case and camelCase, without accents. */
export function words(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** The first word of a list found in a text, in the text's order. */
function first(found: readonly string[], set: ReadonlySet<string>): string | null {
  for (const word of found) if (set.has(word)) return word;
  return null;
}

/** The names of the input's fields, one level down (enough for "delete_all", "overwrite"). */
function fieldNames(schema: string): string[] {
  try {
    const parsed = JSON.parse(schema) as { properties?: unknown };
    const properties = parsed && typeof parsed === "object" && parsed.properties && typeof parsed.properties === "object" ? Object.keys(parsed.properties) : [];
    return properties.slice(0, 100);
  } catch {
    return [];
  }
}

export function classifyTool(tool: { name: string; title: string | null; description: string; input_schema: string; annotations: string | null }): Classification {
  const name = words(`${tool.name} ${tool.title ?? ""}`);
  const description = words(tool.description);
  const fields = words(fieldNames(tool.input_schema).join(" "));
  const places = [
    ["name", name],
    ["description", description],
    ["fields", fields],
  ] as const;
  // Deleting anywhere counts; a writing word in the description only when the name doesn't say it looks
  // things up ("Lists the open issues" is still a search).
  const read = first(name, READ_SET);
  const find = (set: ReadonlySet<string>, kind: McpToolKind, where: readonly (typeof places)[number][]): Classification | null => {
    for (const [source, list] of where) {
      const word = first(list, set);
      if (word) return { kind, reason: { source, word } };
    }
    return null;
  };
  const found =
    find(DESTRUCTIVE_SET, "destructive", places) ?? find(WRITE_SET, "write", read ? places.filter(([source]) => source !== "description") : places);
  const hints = parseHints(tool.annotations);
  if (hints.destructive === true && found?.kind !== "destructive") return { kind: "destructive", reason: { source: "server" } };
  if (found) return found;
  // Only a look-up verb in the name makes a tool "read"; the server saying so alone does not.
  if (read) return { kind: "read", reason: { source: "name", word: read } };
  return { kind: "write", reason: { source: "unknown" } };
}

export const isKind = (value: unknown): value is McpToolKind => typeof value === "string" && (MCP_TOOL_KINDS as readonly string[]).includes(value);
