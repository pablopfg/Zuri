import { type MessageKey, ptBR, REVIEW_GUARD_CODES } from "@zuri/shared";
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/lib/api.ts";
import { guardTexts, REVIEW_BREAKER_TEXT, REVIEW_PROBLEM_TEXT, REVIEW_REASON_TEXT, REVIEW_SOURCE_TEXT, REVIEW_STATE_TEXT, refusedCodes } from "../src/lib/reviews.ts";

const t = (key: MessageKey) => ptBR[key];

describe("the reviews' texts", () => {
  it("has a pt-BR text for every state, reason, source, problem and breaker reason the server sends", () => {
    for (const map of [REVIEW_STATE_TEXT, REVIEW_REASON_TEXT, REVIEW_SOURCE_TEXT, REVIEW_PROBLEM_TEXT, REVIEW_BREAKER_TEXT]) {
      for (const key of Object.values(map)) expect(ptBR[key], key).toBeTruthy();
    }
  });

  it("says every checker code in the owner's words and leaves out what it does not know", () => {
    expect(guardTexts([...REVIEW_GUARD_CODES], t)).toHaveLength(REVIEW_GUARD_CODES.length);
    expect(guardTexts(["signature", "nope", 3, null, "__proto__"], t)).toEqual([ptBR["web.reviews.guard.signature"]]);
    expect(guardTexts("signature", t)).toEqual([]);
    expect(guardTexts(undefined, t)).toEqual([]);
  });

  it("reads the checker's codes only from a refused reply", () => {
    expect(refusedCodes(new ApiError(400, "VALIDATION_FAILED", "x", { codes: ["size"] }))).toEqual(["size"]);
    expect(refusedCodes(new ApiError(400, "VALIDATION_FAILED", "x", { codes: "size" }))).toBeNull();
    expect(refusedCodes(new ApiError(400, "VALIDATION_FAILED", "x"))).toBeNull();
    expect(refusedCodes(new ApiError(409, "CONFLICT", "x", { codes: ["size"] }))).toBeNull();
    expect(refusedCodes(new Error("x"))).toBeNull();
  });
});
