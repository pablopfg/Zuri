import { CRM_LIMITS } from "@zuri/shared";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import { type CrmNotice, CrmService } from "../src/crm/service.ts";
import { Database } from "../src/db/database.ts";
import { migrate } from "../src/db/migrations.ts";
import { AppError } from "../src/http/errors.ts";
import { testEnv } from "./helpers.ts";

// Step 22b: the internal CRM's service, over a database of its own and a clock the test moves.

const ZONE = "America/Sao_Paulo";
let objects = 0;

interface World {
  db: Database;
  crm: CrmService;
  notices: CrmNotice[];
  clock: { now: number };
  zone: { value: string };
}

function withCrm<T>(fn: (world: World) => T | Promise<T>): Promise<T> {
  const stub = testEnv.AGENT.get(testEnv.AGENT.idFromName(`crm-service-${++objects}`));
  return runInDurableObject(stub, async (_agent: ZuriAgent, state) => {
    const db = new Database(state.storage);
    migrate(db);
    // 03/11/2026 12:00 in São Paulo.
    const clock = { now: Date.parse("2026-11-03T15:00:00.000Z") };
    const zone = { value: ZONE };
    const notices: CrmNotice[] = [];
    const crm = new CrmService({ db, timeZone: () => zone.value, locale: () => "pt-BR", notify: (notice) => notices.push(notice), clock: () => clock.now });
    return fn({ db, crm, notices, clock, zone });
  });
}

const refusal = (fn: () => unknown): AppError => {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
};

describe("the funnel", () => {
  it("starts with five stages in the owner's language, made once", () =>
    withCrm(({ crm, db }) => {
      expect(crm.stages().map((stage) => stage.name)).toEqual(["Novo", "Em conversa", "Agendado", "Cliente", "Inativo"]);
      crm.stages();
      expect(db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_crm_stages`)?.n).toBe(5);
    }));

  it("renames, reorders, adds and removes stages; a removed stage's clients move to the first", () =>
    withCrm(({ crm }) => {
      const [novo, conversa, , , inativo] = crm.stages();
      const ana = crm.create({ name: "Ana", stageId: inativo?.id }, "app");
      const stages = crm.setStages([{ id: conversa?.id, name: "Conversando" }, { id: novo?.id, name: "Novo" }, { name: "Fechado" }]);
      expect(stages.map((stage) => stage.name)).toEqual(["Conversando", "Novo", "Fechado"]);
      expect(crm.get(ana.id)?.stageId).toBe(conversa?.id);
      expect(stages[0]?.count).toBe(1);
    }));

  it("refuses a stage id that isn't there", () =>
    withCrm(({ crm }) => {
      crm.stages();
      expect(refusal(() => crm.setStages([{ id: crypto.randomUUID(), name: "A" }, { name: "B" }])).code).toBe("NOT_FOUND");
    }));

  it("finds a stage by name, any case and accents", () =>
    withCrm(({ crm }) => {
      expect(crm.stageByName("em CONVERSA")).toBe(crm.stages()[1]?.id);
      expect(crm.stageByName("agêndado")).toBe(crm.stages()[2]?.id);
      expect(crm.stageByName("outra")).toBeNull();
    }));
});

describe("clients", () => {
  it("adds one in the first stage with its tags and a history line", () =>
    withCrm(({ crm }) => {
      const client = crm.create({ name: "Conceição Souza", phone: "+55 (11) 98765-4321", tags: ["vip", "vip", "retorno"] }, "app");
      expect(client).toMatchObject({ name: "Conceição Souza", stageId: crm.stages()[0]?.id, tags: ["retorno", "vip"], source: "app", notes: "", followUp: null });
      expect(client.history.map((entry) => entry.kind)).toEqual(["created"]);
      expect(crm.count()).toBe(1);
    }));

  it("searches by name without accents, any piece of the phone and the e-mail", () =>
    withCrm(({ crm }) => {
      crm.create({ name: "Conceição Souza", phone: "+55 11 98765-4321", email: "conceicao@exemplo.com.br" }, "app");
      crm.create({ name: "Bruno", phone: "11 3333-2222" }, "app");
      expect(crm.list({ q: "conceicao" }).clients.map((c) => c.name)).toEqual(["Conceição Souza"]);
      expect(crm.list({ q: "8765" }).clients.map((c) => c.name)).toEqual(["Conceição Souza"]);
      expect(crm.list({ q: "@exemplo" }).clients.map((c) => c.name)).toEqual(["Conceição Souza"]);
      // % and _ are plain characters, never wildcards.
      expect(crm.list({ q: "%" }).clients).toEqual([]);
      expect(crm.list({ q: "_" }).clients).toEqual([]);
    }));

  it("pages by name, the next page after the cursor", () =>
    withCrm(({ crm }) => {
      for (const name of ["Ana", "Bia", "Caio", "Davi", "Eva"]) crm.create({ name }, "app");
      const first = crm.list({ limit: 2 });
      expect(first.clients.map((c) => c.name)).toEqual(["Ana", "Bia"]);
      const second = crm.list({ limit: 2, after: first.next ?? "" });
      expect(second.clients.map((c) => c.name)).toEqual(["Caio", "Davi"]);
      const last = crm.list({ limit: 2, after: second.next ?? "" });
      expect(last).toEqual({ clients: [expect.objectContaining({ name: "Eva" })], next: null });
    }));

  it("filters by stage, tag and follow-up (overdue, today, the week)", () =>
    withCrm(({ crm, clock }) => {
      const [novo, conversa] = crm.stages();
      const at = (hours: number) => new Date(clock.now + hours * 3_600_000).toISOString();
      crm.create({ name: "Atrasado", followUp: { at: at(-2), note: "" }, stageId: conversa?.id, tags: ["vip"] }, "app");
      crm.create({ name: "Hoje", followUp: { at: at(3), note: "" } }, "app");
      crm.create({ name: "Semana", followUp: { at: at(72), note: "" } }, "app");
      crm.create({ name: "Longe", followUp: { at: at(24 * 30), note: "" } }, "app");
      const names = (input: Parameters<CrmService["list"]>[0]) => crm.list(input).clients.map((c) => c.name);
      expect(names({ stage: conversa?.id })).toEqual(["Atrasado"]);
      expect(names({ stage: novo?.id })).toEqual(["Hoje", "Longe", "Semana"]);
      expect(names({ tag: " VIP " })).toEqual(["Atrasado"]);
      expect(names({ followUp: "overdue" })).toEqual(["Atrasado"]);
      expect(names({ followUp: "today" })).toEqual(["Atrasado", "Hoje"]);
      expect(names({ followUp: "week" })).toEqual(["Atrasado", "Hoje", "Semana"]);
      expect(names({ followUp: "any" })).toEqual(["Atrasado", "Hoje", "Longe", "Semana"]);
      expect(crm.summary()).toMatchObject({ total: 4, overdue: 1, today: 2, week: 3, newThisWeek: 4 });
    }));

  it("writes each change of stage, tags and follow-up to the history; nothing for no change", () =>
    withCrm(({ crm, clock }) => {
      const [, conversa] = crm.stages();
      const client = crm.create({ name: "Ana", tags: ["a"] }, "app");
      crm.update(client.id, { name: "Ana" });
      expect(crm.get(client.id)?.history).toHaveLength(1);
      const at = new Date(clock.now + 86_400_000).toISOString();
      const updated = crm.update(client.id, { stageId: conversa?.id, tagsAdd: ["b"], tagsRemove: ["a"], followUp: { at, note: "Ligar" } });
      expect(updated.tags).toEqual(["b"]);
      expect(updated.followUp).toEqual({ at, note: "Ligar" });
      const texts = updated.history.map((entry) => `${entry.kind}:${entry.text}`);
      expect(texts).toEqual(expect.arrayContaining(["stage:Novo → Em conversa", "tags:+b −a", `follow_up:${at} · Ligar`, "created:"]));
    }));

  it("keeps the newest 100 history lines of a client", () =>
    withCrm(({ crm, clock, db }) => {
      const client = crm.create({ name: "Ana" }, "app");
      for (let i = 0; i < CRM_LIMITS.historyPerClient + 5; i++) {
        clock.now += 1_000;
        crm.note(client.id, "note", `linha ${i}`);
      }
      const history = crm.get(client.id)?.history ?? [];
      expect(history).toHaveLength(CRM_LIMITS.historyPerClient);
      expect(history[0]?.text).toBe(`linha ${CRM_LIMITS.historyPerClient + 4}`);
      expect(db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_crm_history`)?.n).toBe(CRM_LIMITS.historyPerClient);
    }));

  it("cleans control and direction characters out of a history line", () =>
    withCrm(({ crm }) => {
      const client = crm.create({ name: "Ana" }, "app");
      expect(crm.note(client.id, "message_in", "oi‮\u0000 tudo\nbem").text).toBe("oi tudo bem");
    }));

  it("deletes a client with its tags and history", () =>
    withCrm(({ crm, db }) => {
      const client = crm.create({ name: "Ana", tags: ["vip"] }, "app");
      crm.note(client.id, "note", "x");
      crm.remove(client.id);
      expect(crm.get(client.id)).toBeNull();
      expect(db.one<{ n: number }>(`SELECT (SELECT count(*) FROM zur_crm_tags) + (SELECT count(*) FROM zur_crm_history) AS n`)?.n).toBe(0);
      expect(crm.count()).toBe(0);
      expect(refusal(() => crm.remove(client.id)).code).toBe("NOT_FOUND");
    }));

  it("refuses the 5,001st client and the 201st distinct tag", () =>
    withCrm(({ crm, db }) => {
      crm.create({ name: "Ana" }, "app");
      db.run(`UPDATE zur_counts SET n = ? WHERE kind = 'crm_clients'`, CRM_LIMITS.clients - 1);
      crm.create({ name: "Última" }, "app");
      expect(refusal(() => crm.create({ name: "Uma a mais" }, "app")).messageKey).toBe("error.crmClientLimit");
      db.run(`UPDATE zur_counts SET n = 2 WHERE kind = 'crm_clients'`);
      const client = crm.create({ name: "Tags" }, "app");
      for (let i = 0; i < CRM_LIMITS.distinctTags; i++) db.run(`INSERT INTO zur_crm_tags (client_id, tag) VALUES (?, ?)`, `outro-${i % 10}`, `t${i}`);
      // A tag already used still goes on; a new one is refused.
      expect(crm.update(client.id, { tagsAdd: ["t1"] }).tags).toEqual(["t1"]);
      expect(refusal(() => crm.update(client.id, { tagsAdd: ["nova"] })).messageKey).toBe("error.crmTagLimit");
    }));

  it("keeps the funnel's and the tags' counts without counting the clients; a tag nobody carries frees its place", () =>
    withCrm(({ crm, db }) => {
      const [novo, conversa] = crm.stages();
      const ana = crm.create({ name: "Ana", tags: ["vip", "retorno"] }, "app");
      const bia = crm.create({ name: "Bia", tags: ["vip"], stageId: conversa?.id }, "app");
      const counts = () => crm.stages().map((stage) => stage.count);
      expect(counts()).toEqual([1, 1, 0, 0, 0]);
      crm.update(ana.id, { stageId: conversa?.id });
      expect(counts()).toEqual([0, 2, 0, 0, 0]);
      crm.update(ana.id, { stageId: conversa?.id, name: "Ana Maria" });
      expect(counts()).toEqual([0, 2, 0, 0, 0]);
      crm.setStages([{ id: novo?.id, name: "Novo" }]);
      expect(counts()).toEqual([2]);
      expect(crm.tags()).toEqual(["retorno", "vip"]);
      crm.update(ana.id, { tagsRemove: ["retorno"] });
      expect(crm.tags()).toEqual(["vip"]);
      crm.remove(bia.id);
      expect(crm.tags()).toEqual(["vip"]);
      expect(counts()).toEqual([1]);
      crm.remove(ana.id);
      expect(crm.tags()).toEqual([]);
      expect(counts()).toEqual([0]);
      // The whole list read one row a stage and one a tag in use, not one a client.
      const before = db.usage.rowsRead;
      crm.stages();
      crm.tags();
      expect(db.usage.rowsRead - before).toBeLessThanOrEqual(4);
      // 200 tags once used, none carried now: a new one goes on.
      for (let i = 0; i < CRM_LIMITS.distinctTags; i++) db.run(`INSERT INTO zur_crm_tag_counts (tag, n) VALUES (?, 0)`, `velha-${i}`);
      const cleo = crm.create({ name: "Cleo" }, "app");
      expect(crm.update(cleo.id, { tagsAdd: ["nova"] }).tags).toEqual(["nova"]);
      expect(db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_crm_tag_counts`)?.n).toBe(1);
    }));

  it("refuses more than 20 tags on one client and an unknown stage", () =>
    withCrm(({ crm }) => {
      const client = crm.create({ name: "Ana", tags: Array.from({ length: 20 }, (_, i) => `t${i}`) }, "app");
      expect(refusal(() => crm.update(client.id, { tagsAdd: ["t20"] })).code).toBe("VALIDATION_FAILED");
      expect(refusal(() => crm.update(client.id, { stageId: crypto.randomUUID() })).code).toBe("NOT_FOUND");
      expect(refusal(() => crm.create({ name: "B", stageId: crypto.randomUUID() }, "app")).code).toBe("NOT_FOUND");
      expect(refusal(() => crm.update(crypto.randomUUID(), { name: "x" })).code).toBe("NOT_FOUND");
    }));
});

describe("notices", () => {
  it("tells each follow-up once when it comes due, and plans the alarm for the next", () =>
    withCrm(({ crm, clock, notices }) => {
      const soon = new Date(clock.now + 60_000).toISOString();
      const later = new Date(clock.now + 3_600_000).toISOString();
      const ana = crm.create({ name: "Ana", followUp: { at: soon, note: "Ligar sobre o exame" } }, "app");
      crm.create({ name: "Bia", followUp: { at: later, note: "" } }, "app");
      expect(crm.nextDue()).toBe(Date.parse(soon));
      expect(crm.tick()).toBe(false);
      clock.now += 60_000;
      expect(crm.tick()).toBe(true);
      expect(notices).toEqual([{ kind: "crm.followUp", clientId: ana.id, name: "Ana", note: "Ligar sobre o exame" }]);
      expect(crm.tick()).toBe(false);
      expect(crm.nextDue()).toBe(Date.parse(later));
      // A new time tells again.
      crm.update(ana.id, { followUp: { at: new Date(clock.now + 120_000).toISOString(), note: "" } });
      clock.now += 120_000;
      crm.tick();
      expect(notices.filter((n) => n.kind === "crm.followUp")).toHaveLength(2);
    }));

  it("tells at most 10 follow-ups in one wake, the rest in one notice", () =>
    withCrm(({ crm, clock, notices }) => {
      const at = new Date(clock.now - 1_000).toISOString();
      for (let i = 0; i < 13; i++) crm.create({ name: `Cliente ${String(i).padStart(2, "0")}`, followUp: { at, note: "" } }, "app");
      crm.tick();
      expect(notices.filter((n) => n.kind === "crm.followUp")).toHaveLength(9);
      expect(notices.at(-1)).toEqual({ kind: "crm.followUps", count: 4 });
      expect(crm.nextDue()).toBeNull();
    }));

  it("tells exactly 10 follow-ups one by one", () =>
    withCrm(({ crm, clock, notices }) => {
      const at = new Date(clock.now - 1_000).toISOString();
      for (let i = 0; i < 10; i++) crm.create({ name: `C${i}`, followUp: { at, note: "" } }, "app");
      crm.tick();
      expect(notices.map((n) => n.kind)).toEqual(Array(10).fill("crm.followUp"));
    }));

  it("says nothing of follow-ups while that notice is off", () =>
    withCrm(({ crm, clock, notices }) => {
      crm.updateSettings({ followUps: false, birthdays: false });
      crm.create({ name: "Ana", followUp: { at: new Date(clock.now - 1).toISOString(), note: "" } }, "app");
      expect(crm.nextDue()).toBeNull();
      expect(crm.tick()).toBe(false);
      expect(notices).toEqual([]);
    }));

  it("tells the day's birthdays at 9 h in the owner's zone, 29 February on the 28th in common years", () =>
    withCrm(({ crm, clock, notices }) => {
      expect(crm.nextDue()).toBeNull();
      crm.create({ name: "Ana", birthday: "11-04" }, "app");
      crm.create({ name: "Bia", birthday: "1990-11-04" }, "app");
      crm.create({ name: "Caio", birthday: "11-05" }, "app");
      // 04/11 09:00 in São Paulo is 12:00 UTC.
      const nine = Date.parse("2026-11-04T12:00:00.000Z");
      expect(crm.nextDue()).toBe(nine);
      clock.now = nine;
      expect(crm.tick()).toBe(true);
      expect(notices).toEqual([{ kind: "crm.birthdays", names: "Ana, Bia", more: 0, day: "2026-11-04" }]);
      expect(crm.nextDue()).toBe(nine + 86_400_000);
      crm.create({ name: "Leap", birthday: "02-29" }, "app");
      clock.now = Date.parse("2027-02-28T11:00:00.000Z");
      crm.planReminder();
      clock.now += 3_600_000;
      crm.tick();
      expect(notices.at(-1)).toMatchObject({ kind: "crm.birthdays", names: "Leap" });
    }));

  it("never tells birthdays at the wrong hour: a notice left from an earlier day waits for 9 h", () =>
    withCrm(({ crm, clock, notices }) => {
      crm.create({ name: "Ana", birthday: "11-04" }, "app");
      expect(crm.nextDue()).toBe(Date.parse("2026-11-04T12:00:00.000Z"));
      // The alarm didn't wake on the 4th; at 02:00 on the 5th a client with a birthday arrives.
      clock.now = Date.parse("2026-11-05T05:00:00.000Z");
      crm.create({ name: "Bia", birthday: "11-05" }, "app");
      expect(crm.tick()).toBe(true);
      expect(notices).toEqual([]);
      expect(crm.nextDue()).toBe(Date.parse("2026-11-05T12:00:00.000Z"));
      clock.now = Date.parse("2026-11-05T12:00:00.000Z");
      crm.tick();
      expect(notices).toEqual([{ kind: "crm.birthdays", names: "Bia", more: 0, day: "2026-11-05" }]);
    }));

  it("keeps 9 h across a daylight-saving change, and 29 February only in leap years", () =>
    withCrm(({ crm, clock, notices, zone }) => {
      zone.value = "America/New_York";
      crm.create({ name: "Ana", birthday: "11-01" }, "app");
      crm.create({ name: "Leap", birthday: "02-29" }, "app");
      // 1 November 2026: clocks go back at 02:00, a 25-hour day; 9 h is 14:00 UTC.
      clock.now = Date.parse("2026-11-01T04:30:00.000Z");
      crm.planReminder();
      expect(crm.nextDue()).toBe(Date.parse("2026-11-01T14:00:00.000Z"));
      clock.now = Date.parse("2026-11-01T14:00:00.000Z");
      crm.tick();
      expect(notices.at(-1)).toMatchObject({ names: "Ana", day: "2026-11-01" });
      // 28 February 2028 is in a leap year: 29 February is told on its own day, not on the 28th.
      clock.now = Date.parse("2028-02-28T13:00:00.000Z");
      crm.planReminder();
      clock.now = Date.parse("2028-02-28T14:00:00.000Z");
      const before = notices.length;
      crm.tick();
      expect(notices.length).toBe(before);
      clock.now = Date.parse("2028-02-29T14:00:00.000Z");
      crm.tick();
      expect(notices.at(-1)).toMatchObject({ names: "Leap", day: "2028-02-29" });
    }));

  it("names at most 5 in a birthday notice and counts the rest", () =>
    withCrm(({ crm, clock, notices }) => {
      for (let i = 0; i < 7; i++) crm.create({ name: `P${i}`, birthday: "11-04" }, "app");
      clock.now = Date.parse("2026-11-04T11:00:00.000Z");
      crm.nextDue();
      clock.now += 3_600_000;
      crm.tick();
      expect(notices[0]).toMatchObject({ names: "P0, P1, P2, P3, P4", more: 2 });
    }));

  it("tells up to 20 new clients from n8n a day, and none while off", () =>
    withCrm(({ crm, notices, clock }) => {
      // The owner's day: 20 at 20:30 in São Paulo, and none more at 21:30 (already the next day in UTC).
      clock.now = Date.parse("2026-11-03T23:30:00.000Z");
      for (let i = 0; i < 20; i++) crm.announceNew({ id: `id${i}`, name: `N${i}` });
      clock.now = Date.parse("2026-11-04T00:30:00.000Z");
      for (let i = 20; i < 22; i++) crm.announceNew({ id: `id${i}`, name: `N${i}` });
      expect(notices).toHaveLength(CRM_LIMITS.newClientNoticesPerDay);
      clock.now = Date.parse("2026-11-04T03:30:00.000Z");
      crm.announceNew({ id: "next-day", name: "Amanhã" });
      expect(notices).toHaveLength(CRM_LIMITS.newClientNoticesPerDay + 1);
      notices.length = CRM_LIMITS.newClientNoticesPerDay;
      crm.updateSettings({ newClients: false });
      notices.length = 0;
      crm.announceNew({ id: "x", name: "x" });
      expect(notices).toEqual([]);
    }));
});
