import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  birthdayMonthDay,
  birthdaySchema,
  CRM_EVENTS_KEY,
  CRM_LIMITS,
  crmClientCreateSchema,
  crmClientsQuerySchema,
  crmClientUpdateSchema,
  crmEmailSchema,
  crmEventSchema,
  crmNoteSchema,
  crmPhoneSchema,
  crmSettingsSchema,
  crmStagesSchema,
  crmTagSchema,
  phoneDigits,
} from "../src/index.ts";

// Step 22b: what the Clients tab, the chat and n8n may send to the CRM, at the exact limits.

const ok = (schema: z.ZodType, value: unknown) => schema.safeParse(value).success;

describe("a client's fields", () => {
  it("birthdays: MM-DD any year (29 February too) or a real YYYY-MM-DD from 1900", () => {
    for (const value of ["05-20", "02-29", "12-31", "1990-05-20", "2000-02-29", "1900-01-01"]) expect(ok(birthdaySchema, value), value).toBe(true);
    for (const value of ["02-30", "13-01", "00-10", "1899-12-31", "1999-02-29", "2026-1-1", "20-05", "", "05-20x"]) expect(ok(birthdaySchema, value), value).toBe(false);
    expect(birthdayMonthDay("1990-05-20")).toBe("05-20");
    expect(birthdayMonthDay("02-29")).toBe("02-29");
    expect(birthdayMonthDay(null)).toBeNull();
    expect(birthdayMonthDay("x")).toBeNull();
  });

  it("phones: as people write them, 4 to 20 digits, at most 32 characters", () => {
    for (const value of ["+55 (11) 98888-7777", "1234", "9".repeat(20), "11.9888.7777"]) expect(ok(crmPhoneSchema, value), value).toBe(true);
    for (const value of ["123", "9".repeat(21), "+55 11 9888a", "tel: 1234", `${"1 ".repeat(16)}1`]) expect(ok(crmPhoneSchema, value), value).toBe(false);
    expect(phoneDigits("+55 (11) 98888-7777")).toBe("5511988887777");
    expect(phoneDigits(null)).toBe("");
  });

  it("e-mails: plain, kept in lower case, at most 254 characters", () => {
    expect(crmEmailSchema.parse(" Ana@Exemplo.COM.br ")).toBe("ana@exemplo.com.br");
    expect(ok(crmEmailSchema, `${"a".repeat(240)}@exemplo.com.br`)).toBe(false);
    for (const value of ["ana", "ana@", "@exemplo.com.br", "ana@exemplo", "a b@exemplo.com.br", "<a@exemplo.com.br>", "a@b@exemplo.com.br"]) {
      expect(ok(crmEmailSchema, value), value).toBe(false);
    }
  });

  it("tags: one line, no comma, spaces squeezed, lower case; at most 40 characters and 20 a client, repeats merged", () => {
    expect(crmTagSchema.parse("  Novo   Lead ")).toBe("novo lead");
    expect(ok(crmTagSchema, "a".repeat(CRM_LIMITS.tag))).toBe(true);
    expect(ok(crmTagSchema, "a".repeat(CRM_LIMITS.tag + 1))).toBe(false);
    for (const value of ["", "a,b", "a\nb", "a\u0000", "a‮b"]) expect(ok(crmTagSchema, value), JSON.stringify(value)).toBe(false);
    const created = crmClientCreateSchema.parse({ name: "Ana", tags: ["VIP", "vip ", "Retorno"] });
    expect(created.tags).toEqual(["vip", "retorno"]);
    expect(ok(crmClientCreateSchema, { name: "Ana", tags: Array.from({ length: 20 }, (_, i) => `t${i}`) })).toBe(true);
    expect(ok(crmClientCreateSchema, { name: "Ana", tags: Array.from({ length: 21 }, (_, i) => `t${i}`) })).toBe(false);
  });

  it("the tag and the e-mail stay expressible as JSON Schema, for the chat's tools", () => {
    expect(() => z.toJSONSchema(z.object({ tag: crmTagSchema, email: crmEmailSchema, tags: z.array(crmTagSchema) }))).not.toThrow();
  });
});

describe("the Clients tab's bodies", () => {
  it("a new client: a name up to 120, empty phone and e-mail as nothing, nothing unknown", () => {
    expect(crmClientCreateSchema.parse({ name: "Ana", phone: "", email: "" })).toMatchObject({ name: "Ana", phone: null, email: null });
    expect(ok(crmClientCreateSchema, { name: "a".repeat(CRM_LIMITS.name) })).toBe(true);
    expect(ok(crmClientCreateSchema, { name: "a".repeat(CRM_LIMITS.name + 1) })).toBe(false);
    expect(ok(crmClientCreateSchema, { name: "  " })).toBe(false);
    expect(ok(crmClientCreateSchema, { name: "Ana\nBia" })).toBe(false);
    expect(ok(crmClientCreateSchema, { name: "Ana", source: "n8n" })).toBe(false);
    expect(ok(crmClientCreateSchema, { name: "Ana", notes: "a".repeat(CRM_LIMITS.notes) })).toBe(true);
    expect(ok(crmClientCreateSchema, { name: "Ana", notes: "a".repeat(CRM_LIMITS.notes + 1) })).toBe(false);
    expect(ok(crmClientCreateSchema, { name: "Ana", stageId: "não é id" })).toBe(false);
  });

  it("a change needs at least one field; a follow-up is an instant with a short note, or null to clear", () => {
    expect(ok(crmClientUpdateSchema, {})).toBe(false);
    expect(ok(crmClientUpdateSchema, { followUp: null })).toBe(true);
    expect(ok(crmClientUpdateSchema, { followUp: { at: "2026-11-10T12:00:00.000Z", note: "a".repeat(CRM_LIMITS.followUpNote) } })).toBe(true);
    expect(ok(crmClientUpdateSchema, { followUp: { at: "2026-11-10T12:00:00.000Z", note: "a".repeat(CRM_LIMITS.followUpNote + 1) } })).toBe(false);
    expect(ok(crmClientUpdateSchema, { followUp: { at: "amanhã" } })).toBe(false);
    expect(ok(crmClientUpdateSchema, { followUp: { at: "2026-11-10T12:00:00.000Z", other: 1 } })).toBe(false);
  });

  it("a note: up to 500 characters, not blank", () => {
    expect(ok(crmNoteSchema, { text: "a".repeat(CRM_LIMITS.historyText) })).toBe(true);
    expect(ok(crmNoteSchema, { text: "a".repeat(CRM_LIMITS.historyText + 1) })).toBe(false);
    expect(ok(crmNoteSchema, { text: " \n " })).toBe(false);
  });

  it("the funnel: 2 to 12 stages, names up to 40, no two alike in any case", () => {
    const stages = (n: number) => ({ stages: Array.from({ length: n }, (_, i) => ({ name: `Etapa ${i}` })) });
    expect(ok(crmStagesSchema, stages(CRM_LIMITS.stagesMin))).toBe(true);
    expect(ok(crmStagesSchema, stages(CRM_LIMITS.stagesMax))).toBe(true);
    expect(ok(crmStagesSchema, stages(CRM_LIMITS.stagesMin - 1))).toBe(false);
    expect(ok(crmStagesSchema, stages(CRM_LIMITS.stagesMax + 1))).toBe(false);
    expect(ok(crmStagesSchema, { stages: [{ name: "Novo" }, { name: "NOVO" }] })).toBe(false);
    expect(ok(crmStagesSchema, { stages: [{ name: "a".repeat(CRM_LIMITS.stage + 1) }, { name: "b" }] })).toBe(false);
  });

  it("the settings and the list's query take only what they know", () => {
    expect(ok(crmSettingsSchema, { followUps: false })).toBe(true);
    expect(ok(crmSettingsSchema, { followUps: "false" })).toBe(false);
    expect(ok(crmSettingsSchema, { events: true })).toBe(false);
    expect(ok(crmClientsQuerySchema, { q: "a".repeat(CRM_LIMITS.query) })).toBe(true);
    expect(ok(crmClientsQuerySchema, { q: "a".repeat(CRM_LIMITS.query + 1) })).toBe(false);
    expect(ok(crmClientsQuerySchema, { followUp: "ontem" })).toBe(false);
    expect(ok(crmClientsQuerySchema, { after: "ana\n0b0b0b0b-1111-4222-8333-444444444444" })).toBe(true);
    expect(ok(crmClientsQuerySchema, { after: "ana\n../../etc" })).toBe(false);
    // A long Korean name, decomposed for search, still pages.
    const hangul = "한".repeat(CRM_LIMITS.name).normalize("NFD");
    expect(ok(crmClientsQuerySchema, { after: `${hangul}\n0b0b0b0b-1111-4222-8333-444444444444` })).toBe(true);
    expect(ok(crmClientsQuerySchema, { limit: "5" })).toBe(false);
  });
});

describe("n8n's events", () => {
  const upsert = (data: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id: "evt-1", type: "client.upsert", data: { ref: "cw-1", ...data }, ...extra });

  it("three closed types, each with its own data; nothing else is read", () => {
    expect(ok(crmEventSchema, upsert({ name: "Ana", phone: "+55 11 98888-7777", tagsAdd: ["Lead"] }))).toBe(true);
    expect(ok(crmEventSchema, { id: "evt-2", type: "client.activity", data: { ref: "cw-1", kind: "message_in", text: "Oi" } })).toBe(true);
    expect(ok(crmEventSchema, { id: "evt-3", type: "client.follow_up", data: { ref: "cw-1", followUp: null } })).toBe(true);
    expect(ok(crmEventSchema, { id: "evt-4", type: "client.delete", data: { ref: "cw-1" } })).toBe(false);
    expect(ok(crmEventSchema, upsert({}, { extra: true }))).toBe(false);
    expect(ok(crmEventSchema, upsert({ owner: "x" }))).toBe(false);
    expect(ok(crmEventSchema, { id: "evt-5", type: "client.activity", data: { ref: "cw-1", kind: "shell" } })).toBe(false);
  });

  it("an id up to 100 and a ref up to 100 printable characters without spaces", () => {
    expect(ok(crmEventSchema, upsert({}, { id: "a".repeat(CRM_LIMITS.eventId) }))).toBe(true);
    expect(ok(crmEventSchema, upsert({}, { id: "a".repeat(CRM_LIMITS.eventId + 1) }))).toBe(false);
    expect(ok(crmEventSchema, upsert({ ref: "a".repeat(CRM_LIMITS.ref) }))).toBe(true);
    expect(ok(crmEventSchema, upsert({ ref: "a".repeat(CRM_LIMITS.ref + 1) }))).toBe(false);
    for (const ref of ["a b", "", "ç", "a‮"]) expect(ok(crmEventSchema, upsert({ ref })), JSON.stringify(ref)).toBe(false);
  });

  it("an activity's text up to 500 characters", () => {
    const activity = (text: string) => ({ id: "e", type: "client.activity", data: { ref: "r", kind: "note", text } });
    expect(ok(crmEventSchema, activity("a".repeat(CRM_LIMITS.historyText)))).toBe(true);
    expect(ok(crmEventSchema, activity("a".repeat(CRM_LIMITS.historyText + 1)))).toBe(false);
  });

  it("the events' key: exactly 22 base64url characters", () => {
    expect(CRM_EVENTS_KEY.test("A".repeat(22))).toBe(true);
    expect(CRM_EVENTS_KEY.test("A".repeat(21))).toBe(false);
    expect(CRM_EVENTS_KEY.test("A".repeat(23))).toBe(false);
    expect(CRM_EVENTS_KEY.test(`${"A".repeat(21)}/`)).toBe(false);
  });
});
