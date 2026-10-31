import { describe, expect, it } from "vitest";
import {
  AI_LIMIT_RANGES,
  CHAT_MESSAGE_MAX,
  CHAT_MODELS,
  chatCancelSchema,
  chatRequestSchema,
  CONVERSATION_TITLE_MAX,
  conversationRenameSchema,
  DESTRUCTIVE_TOOLS,
  isLocalDue,
  PENDING_ACTION_TTL_MS,
  settingsUpdateSchema,
  TASK_PLAN_LIMITS,
  TASK_PLAN_TTL_MS,
  taskPlanConfirmSchema,
  taskPlanContentSchema,
  TOOL_NAMES,
  transcribeRequestSchema,
  VOICE_BASE64_MAX,
  VOICE_LIMITS,
} from "../src/index.ts";

const ID = "0b8f8a52-5b2c-4c55-9a4c-2f1f3e1f4a10";

describe("the chat's constants", () => {
  it("are the specification's", () => {
    expect(CHAT_MESSAGE_MAX).toBe(8_000);
    expect(CONVERSATION_TITLE_MAX).toBe(120);
    expect(TOOL_NAMES).toHaveLength(20);
    expect(new Set(TOOL_NAMES).size).toBe(20);
    for (const name of DESTRUCTIVE_TOOLS) expect(TOOL_NAMES).toContain(name);
    expect(PENDING_ACTION_TTL_MS).toBe(30 * 60_000);
    expect(TASK_PLAN_TTL_MS).toBe(24 * 3_600_000);
    expect(VOICE_LIMITS).toEqual({ maxClipSeconds: 60, maxClipBytes: 2 * 1024 * 1024 });
    expect(VOICE_BASE64_MAX).toBe(2_796_204);
    expect(AI_LIMIT_RANGES.aiMaxToolCalls).toEqual({ min: 1, max: 20, default: 6 });
    expect(AI_LIMIT_RANGES.aiMaxIterations).toEqual({ min: 1, max: 10, default: 4 });
    expect(AI_LIMIT_RANGES.aiMaxContextTokens).toEqual({ min: 2_000, max: 32_000, default: 6_000 });
  });

  it("know each model's context window (checked against the providers' pages on 31/10/2026)", () => {
    expect(Object.fromEntries(Object.entries(CHAT_MODELS).map(([id, model]) => [id, model.context]))).toEqual({
      "@cf/zai-org/glm-4.7-flash": 131_072,
      "@cf/qwen/qwen3-30b-a3b-fp8": 32_768,
      "@cf/meta/llama-4-scout-17b-16e-instruct": 131_000,
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast": 24_000,
    });
  });

  it.each([
    ["aiMaxToolCalls", 1, 20],
    ["aiMaxIterations", 1, 10],
    ["aiMaxContextTokens", 2_000, 32_000],
  ] as const)("%s takes whole numbers from %i to %i, nothing outside (n−1, n+1)", (key, min, max) => {
    for (const ok of [min, max]) expect(settingsUpdateSchema.safeParse({ [key]: ok }).success, `${key}=${ok}`).toBe(true);
    for (const bad of [min - 1, max + 1, min + 0.5, String(min), null]) expect(settingsUpdateSchema.safeParse({ [key]: bad }).success, `${key}=${bad}`).toBe(false);
  });
});

describe("chatRequestSchema", () => {
  it("trims the message and keeps line breaks; refuses a blank one", () => {
    expect(chatRequestSchema.parse({ message: "  oi\nde novo  " })).toEqual({ message: "oi\nde novo" });
    for (const message of ["", "   ", "\n\t"]) expect(chatRequestSchema.safeParse({ message }).success).toBe(false);
  });

  it("takes 8,000 characters (n), not 8,001 (n+1)", () => {
    expect(chatRequestSchema.safeParse({ message: "x".repeat(CHAT_MESSAGE_MAX) }).success).toBe(true);
    expect(chatRequestSchema.safeParse({ message: "x".repeat(CHAT_MESSAGE_MAX + 1) }).success).toBe(false);
  });

  it("refuses a malformed conversation id, control characters and unknown fields", () => {
    expect(chatRequestSchema.safeParse({ message: "oi", conversationId: ID }).success).toBe(true);
    for (const body of [
      { message: "oi", conversationId: "1" },
      { message: "oi", conversationId: ID.toUpperCase() },
      { message: "oi\u0000" },
      { message: "oi", role: "system" },
      { message: 1 },
    ]) {
      expect(chatRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
    expect(chatCancelSchema.safeParse({ conversationId: ID }).success).toBe(true);
    expect(chatCancelSchema.safeParse({}).success).toBe(false);
  });

  it("renames to one line of at most 120 characters", () => {
    expect(conversationRenameSchema.parse({ title: "  Viagem  " })).toEqual({ title: "Viagem" });
    expect(conversationRenameSchema.safeParse({ title: "x".repeat(CONVERSATION_TITLE_MAX) }).success).toBe(true);
    for (const title of ["x".repeat(CONVERSATION_TITLE_MAX + 1), "", "a\nb"]) expect(conversationRenameSchema.safeParse({ title }).success).toBe(false);
  });
});

describe("isLocalDue", () => {
  it("takes real local dates and times, refuses impossible and odd forms", () => {
    for (const ok of ["2026-11-05", "2028-02-29", "2026-11-05T00:00", "2026-11-05T23:59"]) expect(isLocalDue(ok), ok).toBe(true);
    for (const bad of ["2026-02-29", "2026-13-01", "2026-11-31", "2026-11-05T24:00", "2026-11-05T12:60", "05/11/2026", "2026-11-05T12:00Z", "2026-11-05 12:00", ""]) {
      expect(isLocalDue(bad), bad).toBe(false);
    }
  });
});

describe("taskPlanContentSchema", () => {
  const task = (n: number) => ({ key: `t${n}`, title: `Tarefa ${n}`, priority: "medium" });

  it("fills the defaults and takes 1 to 15 tasks the owner kept", () => {
    expect(taskPlanContentSchema.parse({ title: "Plano", tasks: [task(1)] })).toEqual({
      title: "Plano",
      description: "",
      project: { mode: "none" },
      tasks: [{ key: "t1", title: "Tarefa 1", description: "", priority: "medium", due: null, dueSuggested: false }],
    });
    const max = Array.from({ length: TASK_PLAN_LIMITS.maxTasks }, (_, i) => task(i + 1));
    expect(taskPlanContentSchema.safeParse({ title: "P", tasks: max }).success).toBe(true);
    expect(taskPlanContentSchema.safeParse({ title: "P", tasks: [...max, task(16)] }).success).toBe(false);
    expect(taskPlanContentSchema.safeParse({ title: "P", tasks: [] }).success).toBe(false);
  });

  it("refuses an odd key, an impossible date, a project of another shape and unknown fields", () => {
    for (const plan of [
      { title: "P", tasks: [{ ...task(1), key: "x1" }] },
      { title: "P", tasks: [{ ...task(1), key: "t100" }] },
      { title: "P", tasks: [{ ...task(1), due: "2026-02-30" }] },
      { title: "P", tasks: [{ ...task(1), priority: "now" }] },
      { title: "P", tasks: [{ ...task(1), id: ID }] },
      { title: "P", project: { mode: "existing", id: "1" }, tasks: [task(1)] },
      { title: "P", project: { mode: "new", name: "" }, tasks: [task(1)] },
      { title: "P", project: { mode: "delete" }, tasks: [task(1)] },
      { title: "", tasks: [task(1)] },
      { title: "P", tasks: [task(1)], owner: "x" },
    ]) {
      expect(taskPlanContentSchema.safeParse(plan).success, JSON.stringify(plan)).toBe(false);
    }
    expect(taskPlanConfirmSchema.safeParse({ revision: 0, plan: { title: "P", tasks: [task(1)] } }).success).toBe(false);
    expect(taskPlanConfirmSchema.safeParse({ revision: 1, plan: { title: "P", tasks: [task(1)] } }).success).toBe(true);
  });
});

describe("transcribeRequestSchema", () => {
  it("takes base64 audio and the measured seconds, up to 61 (n+1 of the clip's 60 for rounding), not 62", () => {
    expect(transcribeRequestSchema.safeParse({ audio: "AAAA", seconds: 60 }).success).toBe(true);
    expect(transcribeRequestSchema.safeParse({ audio: "AAAA", seconds: 61 }).success).toBe(true);
    for (const body of [
      { audio: "AAAA", seconds: 62 },
      { audio: "AAAA", seconds: 0 },
      { audio: "AAAA", seconds: -1 },
      { audio: "AA!A", seconds: 1 },
      { audio: "AAA", seconds: 1 },
      { audio: "A".repeat(VOICE_BASE64_MAX + 4), seconds: 1 },
      { audio: "AAAA", seconds: 1, mime: "x" },
    ]) {
      expect(transcribeRequestSchema.safeParse(body).success, JSON.stringify(body).slice(0, 60)).toBe(false);
    }
  });
});
