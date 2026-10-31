import { AGENT_INSTANCE_NAME } from "@zuri/shared";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import { Database } from "../src/db/database.ts";
import { LATEST_SCHEMA_VERSION, schemaVersion } from "../src/db/migrations.ts";
import { CSRF, ORIGIN, call, errorBody, testEnv } from "./helpers.ts";

// Its own file: it breaks the owner's database before the first request.
const inOwner = <T>(fn: (db: Database) => T) =>
  runInDurableObject(testEnv.AGENT.get(testEnv.AGENT.idFromName(AGENT_INSTANCE_NAME)), (_agent: ZuriAgent, state) =>
    fn(new Database(state.storage)),
  );

describe("a migration that fails on first use", () => {
  it("still answers in pt-BR, logs only the error name, and is retried on the next request", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    // A version table without updated_at makes migration 1's version bump fail.
    await inOwner((db) => db.run(`CREATE TABLE zur_schema_version (id INTEGER PRIMARY KEY, version INTEGER NOT NULL)`));

    const first = await call(`${ORIGIN}/api/tasks`, { headers: CSRF });
    expect(first.status).toBe(401);
    expect(await errorBody(first)).toEqual({ code: "UNAUTHORIZED", message: "Entre para continuar." });
    expect(log).toHaveBeenCalledWith(JSON.stringify({ level: "error", event: "settings_unreadable", error: "Error" }));
    expect(await inOwner(schemaVersion)).toBe(0);
    expect(await inOwner((db) => db.one(`SELECT name FROM sqlite_master WHERE name = 'zur_settings'`))).toBeNull();

    // The failure was not cached: once the cause is gone, the next request migrates.
    await inOwner((db) => db.run(`ALTER TABLE zur_schema_version ADD COLUMN updated_at TEXT`));
    expect((await call(`${ORIGIN}/api/tasks`, { headers: CSRF })).status).toBe(401);
    expect(await inOwner(schemaVersion)).toBe(LATEST_SCHEMA_VERSION);
    log.mockRestore();
  });
});
