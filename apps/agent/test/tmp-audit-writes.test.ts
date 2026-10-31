import { totpCode, totpStep } from "@zuri/shared";
import { describe, expect, it } from "vitest";
import { client, live, noCookies, outcome, right, withAuth } from "./auth-harness.ts";

describe("audit: writes per paused request", () => {
  it("each paused /auth/mfa request inserts an auth event", async () => {
    await withAuth("tmp-audit-writes", async (h) => {
      const { token } = await h.auth.login(right(), client("198.51.100.41"), noCookies);
      const row = await live(h.auth, token);
      const setup = await h.service.mfaSetup(row);
      await h.service.mfaEnable(row, await totpCode(setup.secret, totpStep(h.clock.now())), client("198.51.100.41"));
      h.clock.advance(30_000);
      const ch = async (net: string) => {
        const r = await h.service.login(right(), client(net), noCookies);
        if (!("mfa" in r)) throw new Error("x");
        return r.mfa.token;
      };
      for (let i = 0; i < 10; i++) {
        const net = `203.0.113.${100 + i}`;
        await outcome(h.service.completeMfa(await ch(net), "000000", client(net), noCookies));
      }
      const held = await ch("203.0.113.200");
      const before = h.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_auth_events`)?.n ?? 0;
      const results = new Map<string, number>();
      for (let i = 0; i < 500; i++) {
        const o = await outcome(h.service.completeMfa(held, "000000", client("203.0.113.200"), noCookies));
        results.set(String(o), (results.get(String(o)) ?? 0) + 1);
        h.clock.advance(100);
      }
      const after = h.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_auth_events`)?.n ?? 0;
      const attempts = h.db.one<{ attempts: number }>(`SELECT attempts FROM zur_mfa_challenges ORDER BY created_at DESC LIMIT 1`);
      console.log("RESULTS", JSON.stringify([...results]), "EVENTS_ADDED", after - before, "ATTEMPTS", attempts?.attempts);
      expect(after - before).toBeGreaterThan(0);
    });
  });
});
