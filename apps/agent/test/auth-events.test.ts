import { MAX_AUTH_EVENTS, RESERVED_OWNER_AUTH_EVENTS } from "@zuri/shared";
import { describe, expect, it } from "vitest";
import { AuthEvents } from "../src/auth/events.ts";
import { client, FakeClock, HOUR, MINUTE, noCookies, outcome, right, withAuth, wrong } from "./auth-harness.ts";

const NET = "203.0.113.7";
const DAY = 24 * HOUR;

describe("alerts waiting for step 11 (alert_pending)", () => {
  it("none for the very first sign-in; one for a new browser; none for the same browser and network", async () => {
    await withAuth("alerts", async ({ auth, events }) => {
      const first = await auth.login(right(), client(NET), noCookies);
      expect(events().at(-1)).toMatchObject({ kind: "login_success", alert_pending: 0, known_device: 0 });

      // Same browser (its device cookie), same network: nothing to tell.
      const again = await auth.login(right(), client(NET), { session: null, device: first.deviceToken });
      expect(again.deviceToken).toBe(first.deviceToken);
      expect(events().at(-1)).toMatchObject({ kind: "login_success", alert_pending: 0, known_device: 1 });

      // A browser without the cookie: a new device.
      await auth.login(right(), client(NET), noCookies);
      expect(events().at(-1)).toMatchObject({ kind: "login_success", alert_pending: 1, known_device: 0, reason: "new_device" });
    });
  });

  it("one for a known browser on a network with no sign-in in 30 days", async () => {
    await withAuth("alerts-network", async ({ auth, events }) => {
      const first = await auth.login(right(), client(NET), noCookies);
      await auth.login(right(), client("198.51.100.77"), { session: null, device: first.deviceToken });
      expect(events().at(-1)).toMatchObject({ alert_pending: 1, known_device: 1, reason: "new_network" });
    });
  });

  it("a forged or unknown device cookie is just a new device, and is replaced", async () => {
    await withAuth("alerts-forged", async ({ auth, events }) => {
      await auth.login(right(), client(NET), noCookies);
      for (const device of ["forjado", "A".repeat(43), "<script>"]) {
        const signed = await auth.login(right(), client(NET), { session: null, device });
        expect(signed.deviceToken).not.toBe(device);
        expect(events().at(-1)).toMatchObject({ known_device: 0, alert_pending: 1 });
      }
    });
  });

  it("are listed for delivery", async () => {
    await withAuth("alerts-list", async ({ auth }) => {
      await auth.login(right(), client(NET), noCookies);
      await auth.login(right(), client(NET), noCookies);
      expect(auth.events.pendingAlerts()).toEqual([expect.objectContaining({ kind: "login_success", reason: "new_device" })]);
    });
  });
});

describe("what the access activity keeps", () => {
  it("never the password or the e-mail typed, and the user agent without control characters", async () => {
    await withAuth("privacy", async ({ auth, db }) => {
      const typed = { email: "alguem.errado@exemplo.com.br", password: "senha secreta digitada errado" };
      await outcome(auth.login(typed, client(NET, { userAgent: "Agente\u0000\nFalso " }), noCookies));
      const everything = JSON.stringify([db.all(`SELECT * FROM zur_auth_events`), db.all(`SELECT * FROM zur_login_attempts`)]);
      expect(everything).not.toContain("alguem.errado");
      expect(everything).not.toContain("secreta");
      expect(db.one(`SELECT kind, reason, network, country FROM zur_auth_events`)).toEqual({
        kind: "login_failure",
        reason: "credentials",
        network: NET,
        country: "BR",
      });
    });
  });

  it("folds a blocked network's refusals into one row per window, written at most once a minute", async () => {
    await withAuth("fold", async ({ auth, clock, events }) => {
      for (let i = 0; i < 3; i++) await outcome(auth.login(wrong(), client(NET), noCookies));
      for (let i = 0; i < 50; i++) await outcome(auth.login(right(), client(NET), noCookies));
      clock.advance(MINUTE);
      await outcome(auth.login(right(), client(NET), noCookies));
      const limited = events().filter((e) => e.kind === "login_rate_limited");
      expect(limited).toHaveLength(1);
      // The first refusal made the row; the 51 after it wrote once (a minute later).
      expect(limited[0]?.count).toBe(2);
    });
  });
});

describe("retention", () => {
  it("turns detail older than 90 days into daily counts, and drops counts older than a year", async () => {
    const clock = new FakeClock(Date.parse("2026-01-10T12:00:00Z"));
    await withAuth(
      "retention",
      async ({ db, state }) => {
        const log = new AuthEvents(db, state, clock.now);
        log.record("login_failure", client(NET));
        log.record("login_failure", client(NET));
        log.record("login_success", client(NET));
        clock.advance(90 * DAY - 1);
        // Pruning runs at most once an hour; this is well past that.
        log.prune();
        expect(db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_auth_events`)?.n).toBe(3);

        clock.advance(HOUR + 1);
        log.prune();
        expect(db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_auth_events`)?.n).toBe(0);
        expect(db.all(`SELECT * FROM zur_auth_events_daily ORDER BY kind`)).toEqual([
          { day: "2026-01-10", kind: "login_failure", country: "BR", count: 2 },
          { day: "2026-01-10", kind: "login_success", country: "BR", count: 1 },
        ]);
        // No IP, no user agent in the summary.
        expect(JSON.stringify(db.all(`SELECT * FROM zur_auth_events_daily`))).not.toContain(NET);

        clock.advance(365 * DAY);
        log.prune();
        expect(db.all(`SELECT * FROM zur_auth_events_daily`)).toEqual([]);
      },
      { clock },
    );
  });

  it("caps the detail, and a flood of refusals never pushes out the owner's own events", async () => {
    const clock = new FakeClock();
    await withAuth(
      "cap",
      async ({ db, state }) => {
        const log = new AuthEvents(db, state, clock.now);
        const owner = RESERVED_OWNER_AUTH_EVENTS + 10;
        const flood = MAX_AUTH_EVENTS;
        db.transaction(() => {
          for (let i = 0; i < owner; i++) {
            db.run(`INSERT INTO zur_auth_events (at, last_at, kind) VALUES (?, ?, 'login_success')`, clock.now() + i, clock.now() + i);
          }
          for (let i = 0; i < flood; i++) {
            const at = clock.now() + owner + i;
            db.run(`INSERT INTO zur_auth_events (at, last_at, kind) VALUES (?, ?, 'login_failure')`, at, at);
          }
        });
        clock.advance(2 * HOUR);
        log.prune();
        const counts = db.all<{ kind: string; n: number }>(`SELECT kind, count(*) AS n FROM zur_auth_events GROUP BY kind ORDER BY kind`);
        expect(counts).toEqual([
          { kind: "login_failure", n: MAX_AUTH_EVENTS - RESERVED_OWNER_AUTH_EVENTS },
          { kind: "login_success", n: RESERVED_OWNER_AUTH_EVENTS },
        ]);
      },
      { clock },
    );
  });

  it("remembers at most 50 browsers, dropping the one unseen the longest", async () => {
    await withAuth("devices", async ({ db, state, clock }) => {
      const log = new AuthEvents(db, state, clock.now);
      for (let i = 0; i < 51; i++) {
        clock.advance(1_000);
        log.rememberDevice(`aparelho-${i}`);
      }
      expect(db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_devices`)?.n).toBe(50);
      expect(log.isKnownDevice("aparelho-0")).toBe(false);
      expect(log.isKnownDevice("aparelho-50")).toBe(true);
    });
  });
});
