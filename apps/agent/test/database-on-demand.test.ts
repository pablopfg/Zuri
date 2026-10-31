import { AGENT_INSTANCE_NAME } from "@zuri/shared";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import { Database } from "../src/db/database.ts";
import { LATEST_SCHEMA_VERSION } from "../src/db/migrations.ts";
import { CSRF, ORIGIN, call, testEnv } from "./helpers.ts";

// Its own file: storage is shared by the tests of a file, and this one needs
// the owner's database to start empty.
const inOwner = <T>(fn: (db: Database) => T) =>
  runInDurableObject(testEnv.AGENT.get(testEnv.AGENT.idFromName(AGENT_INSTANCE_NAME)), (_agent: ZuriAgent, state) =>
    fn(new Database(state.storage)),
  );

const zurTables = (db: Database) =>
  db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'zur\\_%' ESCAPE '\\'`).map((r) => r.name);

describe("the database on demand", () => {
  it("is not touched by the health check", async () => {
    expect((await call(`${ORIGIN}/api/health`)).status).toBe(200);
    expect(await inOwner(zurTables)).toEqual([]);
  });

  it("is created on the first request that needs it, at the latest migration", async () => {
    expect((await call(`${ORIGIN}/api/tasks`, { headers: CSRF })).status).toBe(401);
    const version = await inOwner((db) => db.one<{ version: number }>(`SELECT version FROM zur_schema_version`)?.version);
    expect(version).toBe(LATEST_SCHEMA_VERSION);
  });
});

