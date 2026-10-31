import { AGENT_INSTANCE_NAME, DEFAULT_SETTINGS } from "@zuri/shared";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import { Database } from "../src/db/database.ts";
import { migrate } from "../src/db/migrations.ts";
import { SettingsRepository } from "../src/db/settings.ts";
import { AppError } from "../src/http/errors.ts";
import { CSRF, ORIGIN, call, errorBody, testEnv } from "./helpers.ts";

const owner = () => testEnv.AGENT.get(testEnv.AGENT.idFromName(AGENT_INSTANCE_NAME));
const inOwner = <T>(fn: (agent: ZuriAgent, db: Database) => T | Promise<T>) =>
  runInDurableObject(owner(), (agent: ZuriAgent, state) => fn(agent, new Database(state.storage)));

function withRepository<T>(
  name: string,
  fn: (settings: SettingsRepository, db: Database) => T,
  installDefaults?: { timeZone?: string },
): Promise<T> {
  const stub = testEnv.AGENT.get(testEnv.AGENT.idFromName(`settings-test-${name}`));
  return runInDurableObject(stub, (_agent: ZuriAgent, state) => {
    const db = new Database(state.storage);
    migrate(db);
    return fn(new SettingsRepository(db, installDefaults), db);
  });
}

describe("SettingsRepository", () => {
  it("returns the defaults on a new database", async () => {
    await withRepository("defaults", (settings) => {
      expect(settings.get()).toEqual({ ...DEFAULT_SETTINGS, language: "pt-BR", timeZone: "America/Sao_Paulo" });
      expect(settings.locale()).toBe("pt-BR");
    });
  });

  it("starts from the deploy's DEFAULT_TIMEZONE when it is valid, and ignores it when not", async () => {
    await withRepository("install-zone", (settings) => expect(settings.get().timeZone).toBe("America/Manaus"), {
      timeZone: "America/Manaus",
    });
    for (const timeZone of ["", "  ", "Nowhere/City", "America/Sao Paulo"]) {
      await withRepository(`install-bad-${timeZone.length}`, (settings) => expect(settings.get().timeZone).toBe("America/Sao_Paulo"), {
        timeZone,
      });
    }
  });

  it("uses the deploy's time zone in the owner's instance", async () => {
    expect(testEnv.DEFAULT_TIMEZONE).toBe("America/Sao_Paulo");
    expect(await inOwner((agent) => agent.store.settings.get().timeZone)).toBe("America/Sao_Paulo");
  });

  it("saves a change and keeps the other fields at their defaults", async () => {
    await withRepository("update", (settings, db) => {
      expect(settings.update({ language: "en" })).toEqual({ ...DEFAULT_SETTINGS, language: "en", timeZone: "America/Sao_Paulo" });
      expect(settings.get().language).toBe("en");
      expect(db.all(`SELECT key, value FROM zur_settings`)).toEqual([{ key: "language", value: '"en"' }]);

      settings.update({ timeZone: "Europe/Lisbon" });
      expect(settings.get()).toEqual({ ...DEFAULT_SETTINGS, language: "en", timeZone: "Europe/Lisbon" });
    });
  });

  it("logs which fields changed, never their values, and nothing for a no-op", async () => {
    await withRepository("activity", (settings, db) => {
      settings.update({ language: "en", timeZone: "UTC" });
      settings.update({ language: "en" });
      const rows = db.all<{ kind: string; detail: string }>(`SELECT kind, detail FROM zur_activity`);
      expect(rows).toEqual([{ kind: "settings.updated", detail: JSON.stringify({ fields: ["language", "timeZone"] }) }]);
      expect(rows[0]?.detail).not.toContain("UTC");
    });
  });

  it("refuses an invalid change with VALIDATION_FAILED, the field names only, and writes nothing", async () => {
    await withRepository("invalid", (settings, db) => {
      for (const patch of [{}, { language: "fr" }, { timeZone: "Nowhere/<script>" }, { theme: "dark" }, { language: "en", extra: 1 }]) {
        let error: unknown;
        try {
          settings.update(patch as never);
        } catch (e) {
          error = e;
        }
        expect(error, JSON.stringify(patch)).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe("VALIDATION_FAILED");
        expect(JSON.stringify((error as AppError).details)).not.toMatch(/fr|script|dark/);
      }
      expect(db.all(`SELECT * FROM zur_settings`)).toEqual([]);
      expect(db.all(`SELECT * FROM zur_activity`)).toEqual([]);
    });
  });

  it("reads a corrupt or no longer valid stored value as the default", async () => {
    await withRepository("corrupt", (settings, db) => {
      db.run(`INSERT INTO zur_settings (key, value, updated_at) VALUES ('language', '"fr"', 'x'), ('time_zone', '{not json', 'x')`);
      expect(settings.get()).toEqual(DEFAULT_SETTINGS);
      db.run(`UPDATE zur_settings SET value = '"Mars/Base"' WHERE key = 'time_zone'`);
      expect(settings.get().timeZone).toBe("America/Sao_Paulo");
    });
  });
});

describe("API errors in the owner's language", () => {
  it("answer in pt-BR by default and in English after the owner switches", async () => {
    const before = await errorBody(await call(`${ORIGIN}/api/tasks`, { headers: CSRF }));
    expect(before).toEqual({ code: "UNAUTHORIZED", message: "Entre para continuar." });

    await inOwner((agent) => agent.store.settings.update({ language: "en" }));
    const unauthorized = await errorBody(await call(`${ORIGIN}/api/tasks`, { headers: CSRF }));
    expect(unauthorized).toEqual({ code: "UNAUTHORIZED", message: "Sign in to continue." });

    await inOwner((agent) => agent.store.settings.update({ language: "pt-BR" }));
    expect((await errorBody(await call(`${ORIGIN}/api/tasks`, { headers: CSRF }))).message).toBe("Entre para continuar.");
  });

  it("keep the stable code whatever the language", async () => {
    await inOwner((agent) => agent.store.settings.update({ language: "en" }));
    const res = await call(`${ORIGIN}/api/nada`, { method: "POST", headers: CSRF });
    expect(res.status).toBe(401);
    expect(await errorBody(res)).toEqual({ code: "UNAUTHORIZED", message: "Sign in to continue." });
  });

  it("stay in the default language for the Worker's gates, which answer before the object is woken", async () => {
    await inOwner((agent) => agent.store.settings.update({ language: "en" }));
    const res = await call("https://outro.exemplo.com.br/api/tasks", { headers: CSRF });
    expect(await errorBody(res)).toEqual({ code: "HOST_NOT_ALLOWED", message: "Este endereço não atende a Zuri." });
  });

  it("fall back to pt-BR if the database cannot be read, and log only the error's name", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const locale = await inOwner((agent, db) => {
      agent.store.settings.update({ language: "en" });
      // Simulates a broken database: the settings table disappears under the agent.
      db.run(`ALTER TABLE zur_settings RENAME TO zur_settings_gone`);
      return agent.locale();
    });
    expect(locale).toBe("pt-BR");
    const res = await call(`${ORIGIN}/api/tasks`, { headers: CSRF });
    expect(res.status).toBe(401);
    expect((await errorBody(res)).message).toBe("Entre para continuar.");
    // Put the table back so a test added after this one finds a whole database.
    await inOwner((_agent, db) => db.run(`ALTER TABLE zur_settings_gone RENAME TO zur_settings`));
    expect(log).toHaveBeenCalledWith(JSON.stringify({ message: "settings unreadable", error: "Error" }));
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/zur_settings|SELECT/);
    log.mockRestore();
  });
});
