/**
 * The i18n lint (npm run lint, CI job "i18n"). It fails when:
 *  - a catalog key exists in one language only, or a translation is empty;
 *  - a catalog key is not used anywhere in the code;
 *  - visible text is written as a literal instead of coming from the catalog:
 *    JSX text, the title / aria-label / placeholder / alt attributes, and the
 *    arguments of `new AppError(...)` (which take a code and a catalog key).
 * Exceptions live in i18n-ignore.json, each one with its reason; an exception
 * that no longer matches anything also fails, so the list never goes stale.
 *
 * Usage: node scripts/lint-i18n.ts [--root <dir>]
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parseAst } from "rolldown/parseAst";
import { catalogs, DEFAULT_LOCALE, LOCALES } from "../packages/shared/i18n/index.ts";
import { API_ERROR_STATUS } from "../packages/shared/src/errors.ts";

/** Where visible text can come from: the interface, the API and the bot, plus the shared code. */
export const SOURCE_DIRS = ["apps/web/src", "apps/agent/src", "packages/shared/src"];
export const IGNORE_FILE = "i18n-ignore.json";

/** Attributes whose value a person reads or hears. */
const TEXT_ATTRIBUTES = new Set(["title", "aria-label", "placeholder", "alt"]);
const LETTER = /\p{L}/u;
const TYPE_WRAPPERS = new Set(["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "TSTypeAssertion", "ParenthesizedExpression"]);

/** `AppError` or `something.AppError`. */
function isAppError(callee: unknown): boolean {
  if (!isNode(callee)) return false;
  if (callee.type === "Identifier") return callee.name === "AppError";
  return callee.type === "MemberExpression" && isNode(callee.property) && callee.property.name === "AppError";
}

export interface Finding {
  file: string;
  line: number;
  text: string;
  rule: "jsx-text" | "jsx-attribute" | "app-error";
}

export interface IgnoreEntry {
  file: string;
  text: string;
  reason: string;
}

interface Node {
  type: string;
  start: number;
  [key: string]: unknown;
}

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof (value as Node).type === "string";

/** The text of a string literal or of a template literal's fixed parts; null for anything computed. */
function literalText(node: unknown): string | null {
  if (!isNode(node)) return null;
  // "Texto" as MessageKey, "Texto" satisfies string, ("Texto")! are still the literal.
  if (TYPE_WRAPPERS.has(node.type)) return literalText(node.expression);
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral") {
    const quasis = node.quasis as { value: { cooked: string | null } }[];
    return quasis.map((q) => q.value.cooked ?? "").join(" ");
  }
  if (node.type === "JSXExpressionContainer") return literalText(node.expression);
  if (node.type === "ConditionalExpression") {
    return [literalText(node.consequent), literalText(node.alternate)].filter((t) => t !== null).join(" ") || null;
  }
  // `cond && <X/>` renders the right side; the left only when it is falsy, and a
  // falsy string has no letters. `a ?? "text"` and `a || "text"` render either.
  if (node.type === "LogicalExpression") {
    const parts = node.operator === "&&" ? [literalText(node.right)] : [literalText(node.left), literalText(node.right)];
    return parts.filter((t) => t !== null).join(" ") || null;
  }
  // Only "+" joins text; a comparison (tab === "conta") renders a boolean, never its operands.
  if (node.type === "BinaryExpression") {
    if (node.operator !== "+") return null;
    return [literalText(node.left), literalText(node.right)].filter((t) => t !== null).join(" ") || null;
  }
  return null;
}

function attributeName(node: Node): string | null {
  const name = node.name as Node | undefined;
  if (!name) return null;
  if (name.type === "JSXIdentifier") return name.name as string;
  if (name.type === "JSXNamespacedName") return `${(name.namespace as Node).name}:${(name.name as Node).name}`;
  return null;
}

/**
 * Finds the visible literals in one file's source. `allowed` holds the catalog
 * keys and the error codes. When given, `strings` collects every string literal
 * of the file (comments never count), to tell which catalog keys are in use.
 */
export function lintSource(code: string, file: string, allowed: ReadonlySet<string>, strings?: Set<string>): Finding[] {
  const lang = file.endsWith(".tsx") ? "tsx" : file.endsWith(".jsx") ? "jsx" : "ts";
  const ast = parseAst(code, { lang }, file) as unknown as Node;
  const lineStarts = [0];
  for (let i = 0; i < code.length; i++) if (code[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (offset: number) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((lineStarts[mid] as number) <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
  const findings: Finding[] = [];
  const report = (node: Node, text: string, rule: Finding["rule"]) => {
    const trimmed = text.replace(/\s+/g, " ").trim();
    if (!LETTER.test(trimmed) || allowed.has(trimmed)) return;
    findings.push({ file, line: lineOf(node.start), text: trimmed, rule });
  };

  // `jsxChild` marks a node sitting directly among a JSX element's children, where {"Texto"} is still text.
  const visit = (node: Node, jsxChild: boolean) => {
    if (node.type === "JSXText") report(node, node.value as string, "jsx-text");
    if (node.type === "JSXExpressionContainer" && jsxChild) {
      const text = literalText(node.expression);
      if (text !== null) report(node, text, "jsx-text");
    }
    if (node.type === "JSXAttribute") {
      const name = attributeName(node);
      if (name && TEXT_ATTRIBUTES.has(name)) {
        const text = literalText(node.value);
        if (text !== null) report(node, text, "jsx-attribute");
      }
    }
    if (strings && node.type === "Literal" && typeof node.value === "string") strings.add(node.value);
    if (strings && node.type === "TemplateLiteral" && (node.expressions as unknown[]).length === 0) {
      strings.add((node.quasis as { value: { cooked: string | null } }[])[0]?.value.cooked ?? "");
    }
    if (node.type === "NewExpression" && isAppError(node.callee)) {
      for (const argument of node.arguments as unknown[]) {
        const text = literalText(argument);
        if (text !== null && isNode(argument)) report(argument, text, "app-error");
      }
    }
    const isElement = node.type === "JSXElement" || node.type === "JSXFragment";
    for (const [key, value] of Object.entries(node)) {
      for (const child of Array.isArray(value) ? value : [value]) {
        if (isNode(child)) visit(child, isElement && key === "children");
      }
    }
  };
  visit(ast, false);
  return findings;
}

function sourceFiles(root: string): string[] {
  return SOURCE_DIRS.flatMap((dir) => {
    const absolute = join(root, dir);
    if (!existsSync(absolute)) return [];
    return readdirSync(absolute, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(ts|tsx|jsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts"))
      .map((entry) => join(entry.parentPath, entry.name));
  });
}

/** Keys missing in a language or translated as an empty string. */
export function catalogProblems(sources: Record<string, Record<string, string>> = catalogs): string[] {
  const problems: string[] = [];
  const reference = Object.keys(sources[DEFAULT_LOCALE] ?? {});
  for (const locale of LOCALES) {
    const catalog = sources[locale] ?? {};
    const keys = new Set(Object.keys(catalog));
    for (const key of reference) if (!keys.has(key)) problems.push(`${locale}: falta a chave "${key}"`);
    for (const key of keys) if (!reference.includes(key)) problems.push(`${DEFAULT_LOCALE}: falta a chave "${key}" (existe só em ${locale})`);
    for (const [key, value] of Object.entries(catalog)) {
      if (value.trim() === "") problems.push(`${locale}: a chave "${key}" está vazia`);
    }
  }
  return problems;
}

/** A key is used when some string literal names it; a plural key ("tasks.count.one") also through its base, as in plural(l, "tasks.count", n). */
export function unusedCatalogKeys(keys: readonly string[], strings: ReadonlySet<string>): string[] {
  const pluralBase = (key: string) => key.replace(/\.(zero|one|two|few|many|other)$/, "");
  return keys.filter((key) => !strings.has(key) && !strings.has(pluralBase(key)));
}

export interface LintResult {
  findings: Finding[];
  catalog: string[];
  unusedKeys: string[];
  ignoreProblems: string[];
}

export function lint(root: string): LintResult {
  const keys = Object.keys(catalogs[DEFAULT_LOCALE]);
  const allowed = new Set<string>([...keys, ...Object.keys(API_ERROR_STATUS)]);
  const files = sourceFiles(root);
  const texts = new Map(files.map((file) => [relative(root, file).split(sep).join("/"), readFileSync(file, "utf8")]));

  const strings = new Set<string>();
  const raw = [...texts].flatMap(([file, code]) => lintSource(code, file, allowed, strings));

  const ignoreProblems: string[] = [];
  const ignorePath = join(root, IGNORE_FILE);
  const parsed = existsSync(ignorePath) ? (JSON.parse(readFileSync(ignorePath, "utf8")) as { ignore?: unknown }) : { ignore: [] };
  const entries = Array.isArray(parsed.ignore) ? (parsed.ignore as IgnoreEntry[]) : [];
  if (!Array.isArray(parsed.ignore)) ignoreProblems.push(`${IGNORE_FILE}: "ignore" precisa ser uma lista`);
  const used = new Set<IgnoreEntry>();
  for (const entry of entries) {
    if (typeof entry?.file !== "string" || typeof entry?.text !== "string" || typeof entry?.reason !== "string" || entry.reason.trim().length < 10) {
      ignoreProblems.push(`${IGNORE_FILE}: toda exceção precisa de "file", "text" e um "reason" que explique o porquê: ${JSON.stringify(entry)}`);
    }
  }
  const findings = raw.filter((finding) => {
    const entry = entries.find((e) => e?.file === finding.file && e?.text === finding.text);
    if (entry) used.add(entry);
    return !entry;
  });
  for (const entry of entries) {
    if (!used.has(entry)) ignoreProblems.push(`${IGNORE_FILE}: a exceção não corresponde a nada (remova-a): ${JSON.stringify(entry)}`);
  }

  const unusedKeys = unusedCatalogKeys(keys, strings);

  return { findings, catalog: catalogProblems(), unusedKeys, ignoreProblems };
}

/** The report a person reads in the CI log, in pt-BR like the rest of the tooling output. */
export function report(result: LintResult): string[] {
  return [
    ...result.findings.map((f) => `${f.file}:${f.line} texto visível fora do catálogo (${f.rule}): ${JSON.stringify(f.text)}`),
    ...result.catalog,
    ...result.unusedKeys.map((key) => `chave do catálogo sem uso no código: "${key}"`),
    ...result.ignoreProblems,
  ];
}

if (import.meta.main) {
  const rootFlag = process.argv.indexOf("--root");
  const root = rootFlag >= 0 && process.argv[rootFlag + 1] ? process.argv[rootFlag + 1] as string : join(import.meta.dirname, "..");
  const problems = report(lint(root));
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    console.error(`\nlint de i18n: ${problems.length} problema(s). Use t() com uma chave do catálogo ou, com motivo, ${IGNORE_FILE}.`);
    process.exit(1);
  }
  console.log("lint de i18n: ok");
}
