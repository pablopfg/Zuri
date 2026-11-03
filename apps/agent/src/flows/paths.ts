import { FORBIDDEN_KEYS } from "@zuri/shared";

/**
 * The items a flow passes from step to step: plain JSON objects. Reading a
 * field follows a dotted path (`cliente.nome`, `itens.0.preco`) only through
 * the object's own keys, so no path reaches a prototype; values written are
 * set on objects made without one.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Item = { [key: string]: Json };

const PLACEHOLDER = /\{\{([^}]*)\}\}/g;

/** The value at `path`, or undefined. */
export function readPath(item: Json, path: string): Json | undefined {
  let current: Json | undefined = item;
  for (const part of path.split(".")) {
    if (FORBIDDEN_KEYS.has(part) || current === null || typeof current !== "object") return undefined;
    if (Array.isArray(current)) {
      if (!/^\d{1,4}$/.test(part)) return undefined;
      current = current[Number(part)];
    } else {
      if (!Object.hasOwn(current, part)) return undefined;
      current = current[part];
    }
  }
  return current;
}

/** A value as text in a template: strings as they are, the rest as JSON, absent as nothing. */
export function asText(value: Json | undefined): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/**
 * `{{path}}` replaced with the item's values. `encode` runs on each value
 * (a request path encodes every one, so a value can't add a segment or a query).
 */
export function fill(template: string, item: Item, extra: Record<string, Json> = {}, encode: (value: string) => string = (value) => value): string {
  return template.replace(PLACEHOLDER, (_, path: string) => {
    const key = path.trim();
    const value = Object.hasOwn(extra, key) ? extra[key] : readPath(item, key);
    return encode(asText(value));
  });
}

/** A template that is exactly one placeholder keeps the value's own type (a number stays a number). */
export function fillValue(template: string, item: Item): Json {
  const whole = /^\{\{([^}]*)\}\}$/.exec(template);
  if (whole) return readPath(item, (whole[1] ?? "").trim()) ?? null;
  return fill(template, item);
}

/** A copy of any parsed JSON as plain data on prototype-less objects; a key that would reach a prototype is dropped. */
export function plain(value: unknown, depth = 0): Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (depth > 32) return null;
  if (Array.isArray(value)) return value.map((entry) => plain(entry, depth + 1));
  if (typeof value === "object") {
    const out: Item = Object.create(null);
    for (const [key, entry] of Object.entries(value)) if (!FORBIDDEN_KEYS.has(key)) out[key] = plain(entry, depth + 1);
    return out;
  }
  return null;
}

/** A new item on a prototype-less object. */
export function newItem(entries: Record<string, Json> = {}): Item {
  return Object.assign(Object.create(null) as Item, entries);
}
