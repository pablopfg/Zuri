import type { McpToolHints, McpToolProblem } from "@zuri/shared";
import { sha256Hex } from "@zuri/shared";
import { z } from "zod";
import { stableStringify } from "../tools/stable.ts";

/** What one discovered tool may bring in. */
export const CATALOG_LIMITS = {
  maxNameLength: 128,
  maxTitle: 80,
  /** What is stored of the server's description; the model reads MCP_LIMITS.descriptionMax of it. */
  maxDescription: 1_000,
  maxSchemaChars: 6_000,
  maxSchemaDepth: 10,
  maxAnnotations: 2_000,
  /** Tools read per server, over at most 5 pages. */
  maxTools: 100,
  maxPages: 5,
  /** What the model gets of one result. */
  maxResultChars: 8_000,
  /** What an approved call keeps, for the card and the next turn. */
  maxStoredResultChars: 1_500,
} as const;

/** A tool as discovery found it, already checked. */
export interface CatalogEntry {
  name: string;
  title: string | null;
  description: string;
  inputSchema: string;
  annotations: string | null;
  schemaHash: string;
  problem: McpToolProblem | null;
}

/** The shape of a tool in a tools/list answer; anything else in it is ignored. */
export interface ListedTool {
  name?: unknown;
  title?: unknown;
  description?: unknown;
  inputSchema?: unknown;
  annotations?: unknown;
}

/** Cut to `max` characters, never splitting a surrogate pair. */
export function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

/** One line, no control or invisible characters: third-party text shown and sent to the model. */
export function plainText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤﻿]/g, " ").replace(/\s+/g, " ").trim();
  return clip(cleaned, max);
}

/**
 * Third-party text as the model reads it inside a tool (description, a
 * field's description): no angle or square brackets, so it can't open a tag
 * nor fake the bracketed note Zuri adds after it.
 */
export function inert(text: string): string {
  return text.replace(/</g, "‹").replace(/>/g, "›").replace(/\[/g, "(").replace(/\]/g, ")");
}

function depth(value: unknown, level = 0): number {
  if (value === null || typeof value !== "object" || level > CATALOG_LIMITS.maxSchemaDepth) return level;
  let max = level;
  for (const v of Object.values(value as Record<string, unknown>)) max = Math.max(max, depth(v, level + 1));
  return max;
}

/** Keywords whose value maps names to subschemas. */
const SCHEMA_MAPS = new Set(["properties", "$defs", "definitions", "dependentSchemas"]);
/** Keywords whose value is data, never a schema. */
const DATA_KEYWORDS = new Set(["enum", "const", "default", "examples"]);

/**
 * The schema without regular expressions (`pattern`, `patternProperties`) and
 * with its descriptions made inert (they reach the model too):
 * Zod would compile them into RegExps that run inside the Durable Object on
 * every call, and a backtracking pattern could stall the whole app. The server
 * still checks its own input; Zuri checks the shape.
 */
export function withoutPatterns(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutPatterns);
  if (node === null || typeof node !== "object") return node;
  const source = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === "pattern" || key === "patternProperties" || key === "format") continue;
    if ((key === "description" || key === "title") && typeof value === "string") out[key] = inert(value);
    else if (DATA_KEYWORDS.has(key)) out[key] = value;
    else if (SCHEMA_MAPS.has(key) && value !== null && typeof value === "object" && !Array.isArray(value)) {
      out[key] = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, sub]) => [name, withoutPatterns(sub)]));
    } else out[key] = withoutPatterns(value);
  }
  // Names patternProperties allowed must not be refused once it is gone.
  if ("patternProperties" in source && out.additionalProperties === false) delete out.additionalProperties;
  return out;
}

/** The server's input schema as Zod, the way every tool of the agent validates. Throws when unsupported. */
export function toZod(schema: unknown): z.ZodType {
  return z.fromJSONSchema(withoutPatterns(schema) as Parameters<typeof z.fromJSONSchema>[0]);
}

/** The server's hints, shown on the screen; they never decide anything. */
export function parseHints(annotations: string | null): McpToolHints {
  if (!annotations) return {};
  try {
    const a = JSON.parse(annotations) as Record<string, unknown>;
    const hints: McpToolHints = {};
    if (typeof a.readOnlyHint === "boolean") hints.readOnly = a.readOnlyHint;
    if (typeof a.destructiveHint === "boolean") hints.destructive = a.destructiveHint;
    return hints;
  } catch {
    return {};
  }
}

/**
 * One discovered tool, checked. A tool too large, too deep or with a schema
 * Zuri can't validate is kept as "invalid" (shown, never usable). The hash
 * covers everything the owner reviews, so any later change asks for a new
 * review; null when the entry isn't a tool at all.
 */
export async function checkTool(tool: ListedTool): Promise<CatalogEntry | null> {
  if (typeof tool.name !== "string" || !tool.name || tool.name.length > CATALOG_LIMITS.maxNameLength) return null;
  const name = plainText(tool.name, CATALOG_LIMITS.maxNameLength);
  if (!name || name !== tool.name) return null;
  const schema = tool.inputSchema ?? { type: "object" };
  const schemaText = JSON.stringify(schema) ?? "null";
  const annotationsRaw = tool.annotations && typeof tool.annotations === "object" ? JSON.stringify(tool.annotations) : null;
  const annotations = annotationsRaw && annotationsRaw.length <= CATALOG_LIMITS.maxAnnotations ? annotationsRaw : null;
  const description = plainText(tool.description, CATALOG_LIMITS.maxDescription);
  const fromAnnotations = tool.annotations && typeof tool.annotations === "object" ? (tool.annotations as { title?: unknown }).title : undefined;
  const title = plainText(tool.title, CATALOG_LIMITS.maxTitle) || plainText(fromAnnotations, CATALOG_LIMITS.maxTitle) || null;
  let problem: McpToolProblem | null = null;
  if (schemaText.length > CATALOG_LIMITS.maxSchemaChars) problem = "schema_too_large";
  else if (depth(schema) > CATALOG_LIMITS.maxSchemaDepth) problem = "schema_too_deep";
  else if (schema === null || typeof schema !== "object" || (schema as { type?: unknown }).type !== "object") problem = "schema_not_object";
  else {
    try {
      toZod(schema);
    } catch {
      problem = "schema_unsupported";
    }
  }
  return {
    name,
    title,
    description,
    inputSchema: problem === "schema_too_large" || problem === "schema_too_deep" ? "{}" : schemaText,
    annotations,
    schemaHash: await sha256Hex(stableStringify({ title, description, schema: problem === "schema_too_large" ? schemaText.length : schema, annotations })),
    problem,
  };
}

/** A block of an MCP tool result, as far as Zuri reads it. */
interface ResultBlock {
  type?: unknown;
  text?: unknown;
  uri?: unknown;
  name?: unknown;
  resource?: { text?: unknown };
}

export interface CallResult {
  content?: unknown;
  structuredContent?: unknown;
  isError?: unknown;
}

/** The text of a result, other content named rather than included, cut to `max`. */
export function resultText(result: CallResult, max: number = CATALOG_LIMITS.maxResultChars): { text: string; truncated: boolean } {
  const parts: string[] = [];
  const blocks = Array.isArray(result.content) ? (result.content as ResultBlock[]) : [];
  for (const block of blocks.slice(0, 50)) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "resource_link" && typeof block.uri === "string") parts.push(`[link: ${typeof block.name === "string" ? block.name : ""} ${block.uri}]`);
    else if (block.type === "resource" && typeof block.resource?.text === "string") parts.push(block.resource.text);
    else parts.push(`[${typeof block.type === "string" ? block.type.slice(0, 20) : "unknown"} content omitted]`);
  }
  if (parts.length === 0 && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent) ?? "");
  const text = parts.join("\n").trim();
  return [...text].length > max ? { text: clip(text, max), truncated: true } : { text, truncated: false };
}
