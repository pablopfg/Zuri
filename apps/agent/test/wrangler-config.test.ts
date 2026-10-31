import wranglerText from "../wrangler.jsonc?raw";
import { describe, expect, it } from "vitest";

/** wrangler.jsonc without its // comments (none of its strings contains "//"). */
const config = JSON.parse(wranglerText.replace(/^\s*\/\/.*$/gm, "")) as {
  assets: Record<string, unknown>;
  workers_dev: boolean;
  preview_urls: boolean;
  durable_objects: { bindings: unknown[] };
  migrations: unknown[];
  vars?: Record<string, string>;
  send_metrics: boolean;
  observability: Record<string, unknown>;
};

describe("wrangler.jsonc", () => {
  it("is one Worker whose every request meets the gates first", () => {
    expect(config.assets).toMatchObject({ binding: "ASSETS", run_worker_first: true, directory: "../web/dist" });
  });

  it("never exposes workers.dev or preview URLs", () => {
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
  });

  it("declares the agent's Durable Object with SQLite in migration v1", () => {
    expect(config.durable_objects.bindings).toEqual([{ name: "AGENT", class_name: "ZuriAgent" }]);
    expect(config.migrations[0]).toEqual({ tag: "v1", new_sqlite_classes: ["ZuriAgent"] });
  });

  it("keeps secrets and personal data out of the file", () => {
    expect(Object.keys(config.vars ?? {}).sort()).toEqual(["AGENT_NAME", "DEFAULT_TIMEZONE"]);
    expect(wranglerText).not.toMatch(/PUBLIC_URL"\s*:/);
    expect(config.send_metrics).toBe(false);
  });

  it("logs without query strings and keeps billed traces off", () => {
    expect(config.observability).toMatchObject({ enabled: true, redact_query_string: true, traces: { enabled: false } });
  });
});
