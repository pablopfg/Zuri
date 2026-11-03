import { QueryClient } from "@tanstack/react-query";
import { AREAS } from "@zuri/shared";
import { afterEach, describe, expect, it } from "vitest";
import { changedIds } from "../src/lib/lists.tsx";
import { changedAreas, cleanVersions, resetVersions, seen } from "../src/lib/versions.ts";

afterEach(() => resetVersions());

/** A client with one active-looking query per key, to see which ones an update invalidates. */
function clientWith(keys: readonly (readonly unknown[])[]) {
  const qc = new QueryClient();
  for (const key of keys) qc.setQueryData(key, { ok: true });
  const stale = () => keys.filter((key) => qc.getQueryState(key)?.isInvalidated).map((key) => JSON.stringify(key));
  return { qc, stale };
}

describe("the areas' numbers", () => {
  it("keep only the known areas with whole, non-negative numbers", () => {
    expect(cleanVersions({ tasks: 3, notes: 1.5, trash: -1, memories: "2", other: 9, automations: Number.NaN, projects: 0 })).toEqual({ tasks: 3, projects: 0 });
    for (const bad of [null, undefined, 7, "tasks", [1, 2]]) expect(cleanVersions(bad)).toEqual({});
    const full = Object.fromEntries(AREAS.map((area, i) => [area, i]));
    expect(cleanVersions(full)).toEqual(full);
  });

  it("the first reading is only the base; after it, only the areas that moved", () => {
    expect(changedAreas(null, { tasks: 1 })).toEqual([]);
    expect(changedAreas({ tasks: 1, notes: 2 }, { tasks: 1, notes: 3 })).toEqual(["notes"]);
    // An area the answer leaves out is not taken as changed (an older server, or a lockdown).
    expect(changedAreas({ tasks: 1, notes: 2 }, { tasks: 2 })).toEqual(["tasks"]);
    // A number that went back (a restored backup) still moved.
    expect(changedAreas({ tasks: 5 }, { tasks: 0 })).toEqual(["tasks"]);
  });

  it("refresh only the queries of the area that moved", () => {
    const keys = [["tasks", { view: "today" }], ["tasks", "counts"], ["notes", "list", ""], ["notes", "one", "n1"], ["memories", "list"], ["conversations"], ["conversations", "one", "c1"], ["session"], ["settings"]] as const;
    const { qc, stale } = clientWith(keys);
    const base = { tasks: 1, projects: 0, notes: 4, trash: 0, memories: 2, automations: 0, conversations: 9 };
    expect(seen(qc, base, false)).toEqual([]);
    expect(stale()).toEqual([]);

    expect(seen(qc, { ...base, tasks: 2 }, false)).toEqual(["tasks"]);
    expect(stale()).toEqual([JSON.stringify(["tasks", { view: "today" }]), JSON.stringify(["tasks", "counts"])]);

    // The recent conversations refresh; an open conversation follows its own stream.
    seen(qc, { ...base, tasks: 2, conversations: 10, notes: 5 }, false);
    expect(stale()).toContain(JSON.stringify(["conversations"]));
    expect(stale()).not.toContain(JSON.stringify(["conversations", "one", "c1"]));
    expect(stale()).toContain(JSON.stringify(["notes", "one", "n1"]));
    expect(stale()).not.toContain(JSON.stringify(["memories", "list"]));
    expect(stale()).not.toContain(JSON.stringify(["session"]));
  });

  it("the same numbers again change nothing", () => {
    const { qc, stale } = clientWith([["tasks"]]);
    seen(qc, { tasks: 1 }, false);
    seen(qc, { tasks: 1 }, false);
    seen(qc, {}, false);
    seen(qc, { tasks: "9" }, false);
    expect(stale()).toEqual([]);
  });
});

describe("the rows that glow", () => {
  const map = (entries: [string, string][]) => new Map(entries);
  it("are the new ones and the changed ones, never on the first reading", () => {
    expect(changedIds(null, map([["a", "1"]]))).toEqual([]);
    expect(changedIds(map([["a", "1"], ["b", "1"]]), map([["a", "1"], ["b", "2"], ["c", "1"]]))).toEqual(["b", "c"]);
    // A row that left the list does not glow (there is nothing to show).
    expect(changedIds(map([["a", "1"], ["b", "1"]]), map([["a", "1"]]))).toEqual([]);
  });
});
