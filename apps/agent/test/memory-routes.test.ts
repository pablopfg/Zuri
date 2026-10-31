import { apiErrorSchema, type Memory, type MemoryCounts, type MemoryHistory, type MemoryReview, type MemoryWriteResult } from "@zuri/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { call, CSRF, HUMAN_TOKEN, ORIGIN, TEST_EMAIL, TEST_PASSWORD } from "./helpers.ts";

// Memories through the Worker, as the interface calls them.

const IP = "192.0.2.130";
let cookie = "";

const headers = (withCookie = true) => ({
  ...CSRF,
  "content-type": "application/json",
  "cf-connecting-ip": IP,
  "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0 Safari/537.36",
  ...(withCookie ? { cookie } : {}),
});

function api(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  return call(`${ORIGIN}/api${path}`, {
    method,
    headers: { ...headers(), ...extra },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

async function json<T>(res: Response, status: number): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await res.json()) as T;
}

const refusal = async (res: Response, status: number) => apiErrorSchema.parse(await json(res, status));
const list = async (query = "") => json<{ memories: Memory[]; counts: MemoryCounts }>(await api("GET", `/memories${query}`), 200);
const create = async (content: string, category = "fact") => json<MemoryWriteResult>(await api("POST", "/memories", { content, category }), 201);

beforeAll(async () => {
  const res = await call(`${ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: headers(false),
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD, turnstileToken: HUMAN_TOKEN }),
  });
  expect(res.status).toBe(200);
  cookie = res.headers.getSetCookie().find((c) => c.startsWith("__Host-zuri_session="))?.split(";")[0] ?? "";
});

const MISSING = "0b8f8a52-5b2c-4c55-9a4c-2f1f3e1f4a10";

describe("the memory routes", () => {
  const routes = [
    ["GET", "/memories"],
    ["POST", "/memories"],
    ["GET", "/memories/reviews"],
    ["POST", `/memories/reviews/${MISSING}`],
    ["GET", `/memories/${MISSING}`],
    ["PATCH", `/memories/${MISSING}`],
    ["DELETE", `/memories/${MISSING}`],
    ["GET", `/memories/${MISSING}/history`],
    ["POST", `/memories/${MISSING}/status`],
    ["POST", `/memories/${MISSING}/correct`],
  ] as const;

  it.each(routes)("%s %s needs a session (401) and the CSRF header (403), and is never cached", async (method, path) => {
    const anonymous = await call(`${ORIGIN}/api${path}`, { method, headers: headers(false) });
    expect((await refusal(anonymous, 401)).code).toBe("UNAUTHORIZED");
    expect(anonymous.headers.get("cache-control")).toBe("no-store");
    const { "x-zuri-request": _, ...withoutCsrf } = headers();
    const forged = await call(`${ORIGIN}/api${path}`, { method, headers: withoutCsrf });
    expect((await refusal(forged, 403)).code).toBe("CSRF_FAILED");
    const otherSite = await call(`${ORIGIN}/api${path}`, { method, headers: { ...headers(), origin: "https://evil.exemplo.com.br" } });
    expect((await refusal(otherSite, 403)).code).toBe("CSRF_FAILED");
  });

  it("an id that isn't one of the server's UUIDs is simply not found, on every route that takes one", async () => {
    for (const id of ["1", "../settings", "x".repeat(37), `${MISSING}%00`, "0B8F8A52-5B2C-4C55-9A4C-2F1F3E1F4A10"]) {
      const res = await api("GET", `/memories/${encodeURIComponent(id)}`);
      expect((await refusal(res, 404)).code).toBe("NOT_FOUND");
    }
    expect((await refusal(await api("DELETE", `/memories/${MISSING}`), 404)).message).toBe("Esta memória não existe mais.");
    expect((await refusal(await api("POST", `/memories/reviews/${MISSING}`, { action: "keep_both" }), 404)).message).toBe("Esta revisão já foi resolvida.");
  });

  it("refuses bad bodies naming only the fields, never echoing the text", async () => {
    const secret = "segredo-que-nao-volta";
    for (const [body, field] of [
      [{ content: "" }, "content"],
      [{ content: `${secret}${"x".repeat(2000)}` }, "content"],
      [{ content: secret, category: "nope" }, "category"],
      [{ content: secret, status: "historical" }, "_body"],
      [{ content: secret, origin: "telegram" }, "_body"],
      [[secret], "_body"],
    ] as const) {
      const res = await api("POST", "/memories", body);
      const error = await refusal(res, 400);
      expect(error.code).toBe("VALIDATION_FAILED");
      expect(error.details).toEqual({ fields: [field] });
      expect(JSON.stringify(error)).not.toContain(secret);
    }
    expect((await refusal(await api("POST", "/memories", "{not json"), 400)).code).toBe("VALIDATION_FAILED");
    expect((await refusal(await api("POST", "/memories", { content: "x" }, { "content-type": "text/plain" }), 400)).code).toBe("VALIDATION_FAILED");
    const huge = await api("POST", "/memories", { content: "x".repeat(20_000) });
    expect((await refusal(huge, 400)).message).toBeTruthy();
    expect((await refusal(await api("GET", "/memories?status=all&status=active"), 400)).details).toEqual({ fields: ["status"] });
    expect((await refusal(await api("GET", "/memories?limit=0"), 400)).code).toBe("VALIDATION_FAILED");
    expect((await refusal(await api("GET", "/memories?extra=1"), 400)).code).toBe("VALIDATION_FAILED");
  });

  it("the whole flow: save, duplicate, review, mark as past, history, restore, update the fact and delete", async () => {
    const vw = await create("Eu dirijo um Volkswagen");
    expect(vw).toMatchObject({ duplicate: false, reviews: 0, memory: { status: "active", origin: "app" } });
    const again = await json<MemoryWriteResult>(await api("POST", "/memories", { content: "eu DIRIJO um volkswagen" }), 200);
    expect(again).toMatchObject({ duplicate: true, memory: { id: vw.memory.id } });

    const tesla = await create("Vendi meu Volkswagen e comprei um Tesla");
    expect(tesla.reviews).toBe(1);
    const { reviews } = await json<{ reviews: MemoryReview[] }>(await api("GET", "/memories/reviews"), 200);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ memory: { id: tesla.memory.id }, other: { id: vw.memory.id }, relationship: "possible_update", topic: "vehicle" });
    expect((await list()).counts).toMatchObject({ reviews: 1 });

    const bad = await refusal(await api("POST", `/memories/reviews/${reviews[0]?.id}`, { action: "drop_table" }), 400);
    expect(bad.details).toEqual({ fields: ["action"] });
    await json(await api("POST", `/memories/reviews/${reviews[0]?.id}`, { action: "mark_historical" }), 200);
    const past = (await list("?status=historical")).memories;
    expect(past.map((m) => m.id)).toEqual([vw.memory.id]);
    expect(past[0]?.supersededBy).toBe(tesla.memory.id);

    const history = await json<MemoryHistory>(await api("GET", `/memories/${tesla.memory.id}/history`), 200);
    expect(history.previous.map((m) => m.id)).toEqual([vw.memory.id]);

    const restored = await json<{ memory: Memory }>(await api("POST", `/memories/${vw.memory.id}/status`, { status: "active" }), 200);
    expect(restored.memory).toMatchObject({ status: "active", supersededBy: null });

    const corrected = await json<MemoryWriteResult>(await api("POST", `/memories/${vw.memory.id}/correct`, { content: "Eu dirijo uma Kombi" }), 201);
    expect(corrected.superseded.map((m) => m.id)).toEqual([vw.memory.id]);
    const same = await refusal(await api("POST", `/memories/${corrected.memory.id}/correct`, { content: "eu dirijo uma kombi" }), 400);
    expect(same.message).toContain("Editar");

    const edited = await json<MemoryWriteResult>(await api("PATCH", `/memories/${corrected.memory.id}`, { category: "preference" }), 200);
    expect(edited.memory.category).toBe("preference");
    expect((await refusal(await api("PATCH", `/memories/${corrected.memory.id}`, {}), 400)).code).toBe("VALIDATION_FAILED");

    const deleted = await api("DELETE", `/memories/${corrected.memory.id}`);
    expect(deleted.status).toBe(204);
    expect((await refusal(await api("GET", `/memories/${corrected.memory.id}`), 404)).code).toBe("NOT_FOUND");
    expect((await list("?q=Kombi")).memories).toEqual([]);
  });

  it("twenty identical saves at the same time store one memory", async () => {
    const text = `Fato simultâneo ${crypto.randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 20 }, () => api("POST", "/memories", { content: text })));
    const statuses = results.map((res) => res.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(19);
    expect((await list(`?q=${encodeURIComponent(text)}`)).memories).toHaveLength(1);
  });

  it("with conflict review off in the settings, a contradiction raises no review", async () => {
    const off = await api("PATCH", "/settings", { memoryConflictReview: false });
    expect(off.status).toBe(200);
    const before = (await list()).counts.reviews;
    await create("Moro em Manaus");
    expect((await create("Moro em Belém")).reviews).toBe(0);
    expect((await list()).counts.reviews).toBe(before);
    expect((await refusal(await api("PATCH", "/settings", { memoryConflictReview: "no" }), 400)).details).toEqual({ fields: ["memoryConflictReview"] });
    expect((await api("PATCH", "/settings", { memoryConflictReview: true })).status).toBe(200);
    expect((await create("Moro em Macapá")).reviews).toBeGreaterThan(0);
  });
});
