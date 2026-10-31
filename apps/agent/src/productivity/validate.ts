import type { z } from "zod";
import { AppError } from "../http/errors.ts";

/** A body as it arrived: the repositories parse it again, so every caller gets the same rules. */
export type Untrusted = Record<string, unknown>;

/**
 * Parses with a schema. A refusal is VALIDATION_FAILED naming the fields with
 * problems, never the values sent (they may be the owner's private text).
 */
export function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.map(String).join(".") || "_body"))];
    throw new AppError("VALIDATION_FAILED", undefined, { fields });
  }
  return parsed.data;
}
