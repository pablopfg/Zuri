import { describe, expect, it } from "vitest";
import { extractWhen, parseWhen, type When } from "../src/telegram/dates.ts";

// Step 15b: the bot's date grammar (spec, "Gramática de datas do bot"), on a
// fixed reference: Monday, 2 November 2026, 10:00 in São Paulo (13:00 UTC).

const ZONE = "America/Sao_Paulo";
const REF = new Date("2026-11-02T13:00:00.000Z");

const local = (text: string, ref = REF) => {
  const when = parseWhen(text, ref, ZONE);
  return when?.kind === "ok" ? when.local : when;
};
const ambiguous = (reason: string, suggestion: string | null = null): When => ({ kind: "ambiguous", reason, suggestion }) as When;

describe("the bot's date grammar", () => {
  it.each([
    ["amanhã", "2026-11-03T09:00"],
    ["Amanhã", "2026-11-03T09:00"],
    ["hoje 15h", "2026-11-02T15:00"],
    ["hoje às 21h", "2026-11-02T21:00"],
    ["depois de amanhã 8h30", "2026-11-04T08:30"],
    ["sexta", "2026-11-06T09:00"],
    ["sexta-feira 18h", "2026-11-06T18:00"],
    ["Terça-Feira", "2026-11-03T09:00"],
    ["quarta feira", "2026-11-04T09:00"],
    ["sábado", "2026-11-07T09:00"],
    ["domingo", "2026-11-08T09:00"],
    ["próxima sexta", "2026-11-06T09:00"],
    ["na sexta às 9h", "2026-11-06T09:00"],
    ["segunda 15h", "2026-11-02T15:00"],
    ["segunda 8h", "2026-11-09T08:00"],
    ["dia 5", "2026-11-05T09:00"],
    ["dia 2 às 18h", "2026-11-02T18:00"],
    ["dia 1", "2026-12-01T09:00"],
    ["dia 31", "2026-12-31T09:00"],
    ["5/11", "2026-11-05T09:00"],
    ["5/11 14h", "2026-11-05T14:00"],
    ["5/11/2027", "2027-11-05T09:00"],
    ["9h", "2026-11-03T09:00"],
    ["21h", "2026-11-02T21:00"],
    ["9:30", "2026-11-03T09:30"],
    ["10:30h", "2026-11-02T10:30"],
    ["às 21h", "2026-11-02T21:00"],
    ["às 9", "2026-11-03T09:00"],
    ["daqui a 3 dias", "2026-11-05T09:00"],
    ["daqui a 2 dias às 7h", "2026-11-04T07:00"],
    ["semana que vem", "2026-11-09T09:00"],
    ["próxima semana", "2026-11-09T09:00"],
    ["sexta que vem", "2026-11-13T09:00"],
    ["sexta da semana que vem 10h", "2026-11-13T10:00"],
    ["domingo da semana que vem", "2026-11-15T09:00"],
    ["amanhã 3h da tarde", "2026-11-03T15:00"],
    ["amanhã 8h da noite", "2026-11-03T20:00"],
    ["amanhã de manhã", "2026-11-03T09:00"],
    ["amanhã às 12h da tarde", "2026-11-03T12:00"],
  ])("%s → %s", (text, expected) => {
    expect(local(text)).toBe(expected);
  });

  it("turns the local time into the instant in the owner's zone", () => {
    expect(parseWhen("amanhã 9h", REF, ZONE)).toEqual({ kind: "ok", at: "2026-11-03T12:00:00.000Z", local: "2026-11-03T09:00", hasTime: true });
    expect(parseWhen("amanhã", REF, ZONE)).toMatchObject({ hasTime: false });
  });

  it("counts minutes and hours from now, rounded up to the minute", () => {
    expect(parseWhen("daqui a 30 minutos", REF, ZONE)).toMatchObject({ kind: "ok", at: "2026-11-02T13:30:00.000Z", local: "2026-11-02T10:30" });
    expect(parseWhen("daqui a 2 horas", REF, ZONE)).toMatchObject({ at: "2026-11-02T15:00:00.000Z" });
    expect(parseWhen("daqui a uma hora", REF, ZONE)).toMatchObject({ at: "2026-11-02T14:00:00.000Z" });
    expect(parseWhen("daqui 5 min", new Date("2026-11-02T13:00:20.000Z"), ZONE)).toMatchObject({ at: "2026-11-02T13:06:00.000Z" });
    // Past midnight in the owner's zone.
    expect(local("daqui a 20 minutos", new Date("2026-11-03T02:50:00.000Z"))).toBe("2026-11-03T00:10");
  });

  it("asks instead of guessing", () => {
    expect(parseWhen("segunda", REF, ZONE)).toEqual(ambiguous("same_weekday"));
    expect(parseWhen("1/11", REF, ZONE)).toEqual(ambiguous("past_date", "01/11/2027"));
    expect(parseWhen("amanhã à tarde", REF, ZONE)).toEqual(ambiguous("period"));
    expect(parseWhen("hoje à noite", REF, ZONE)).toEqual(ambiguous("period"));
    expect(parseWhen("meio-dia", REF, ZONE)).toEqual(ambiguous("period"));
    expect(parseWhen("amanhã meio dia", REF, ZONE)).toEqual(ambiguous("period"));
    expect(parseWhen("hoje 8h", REF, ZONE)).toEqual(ambiguous("past"));
    expect(parseWhen("hoje", REF, ZONE)).toEqual(ambiguous("past"));
    expect(parseWhen("5/11/2025", REF, ZONE)).toEqual(ambiguous("past"));
    // 29 February gone this year and missing next year: no suggestion.
    expect(parseWhen("29/2", new Date("2028-03-01T13:00:00.000Z"), ZONE)).toEqual(ambiguous("past_date"));
  });

  it("refuses what is not a date", () => {
    for (const text of [
      "",
      "banana",
      "25:00",
      "24h",
      "9h75",
      "31/2",
      "5/13",
      "5/11/2300",
      "dia 32",
      "dia 0",
      "amanhã amanhã",
      "9h 10h",
      "sexta segunda",
      "daqui a 0 minutos",
      "daqui a 400 dias",
      "daqui a dois dias",
      "daqui a 5 semanas",
      "daqui a 5 minutos 9h",
      "à tarde à noite",
      "às",
      "amanhã às",
      "semana que vem semana que vem",
    ]) {
      expect(parseWhen(text, REF, ZONE), text).toBeNull();
    }
  });

  it("crosses the year", () => {
    const eve = new Date("2026-12-31T13:00:00.000Z");
    expect(local("amanhã", eve)).toBe("2027-01-01T09:00");
    expect(local("dia 5", eve)).toBe("2027-01-05T09:00");
    expect(local("semana que vem", new Date("2026-11-08T13:00:00.000Z"))).toBe("2026-11-09T09:00");
  });
});

describe("a date inside the text", () => {
  it("takes the longest date at the end, or at the start", () => {
    expect(extractWhen("pagar a luz amanhã 9h", REF, ZONE)).toMatchObject({ rest: "pagar a luz", when: { local: "2026-11-03T09:00" } });
    expect(extractWhen("amanhã 9h pagar a luz", REF, ZONE)).toMatchObject({ rest: "pagar a luz", when: { local: "2026-11-03T09:00" } });
    expect(extractWhen("reunião na sexta às 15h", REF, ZONE)).toMatchObject({ rest: "reunião", when: { local: "2026-11-06T15:00" } });
    expect(extractWhen("ver 5/11 amanhã", REF, ZONE)).toMatchObject({ rest: "ver 5/11", when: { local: "2026-11-03T09:00" } });
    expect(extractWhen("bom dia amanhã", REF, ZONE)).toMatchObject({ rest: "bom dia" });
  });

  it("reads only the start when asked (/lembrar)", () => {
    expect(extractWhen("sexta 18h buscar o bolo", REF, ZONE, "start")).toMatchObject({ rest: "buscar o bolo", when: { local: "2026-11-06T18:00" } });
    expect(extractWhen("buscar o bolo sexta 18h", REF, ZONE, "start")).toBeNull();
    expect(extractWhen("pagar a luz amanhã", REF, ZONE, "end")).toMatchObject({ rest: "pagar a luz" });
  });

  it("finds nothing in plain text, and keeps an ambiguous date as one", () => {
    expect(extractWhen("ligar para a Ana", REF, ZONE)).toBeNull();
    expect(extractWhen("comprar 2 pães", REF, ZONE)).toBeNull();
    expect(extractWhen("", REF, ZONE)).toBeNull();
    expect(extractWhen("dentista segunda", REF, ZONE)).toEqual({ rest: "dentista", when: ambiguous("same_weekday") });
  });
});
