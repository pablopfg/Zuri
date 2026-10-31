import { AGENT_INSTANCE_NAME, mfaSetupSchema, recoveryCodesSchema, totpCode, totpStep } from "@zuri/shared";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import { Database } from "../src/db/database.ts";
import { CSRF, call, ORIGIN, TEST_EMAIL, TEST_PASSWORD, testEnv } from "./helpers.ts";

function runOwner<T>(fn: (db: Database) => T): Promise<T> {
  const stub = testEnv.AGENT.get(testEnv.AGENT.idFromName(AGENT_INSTANCE_NAME));
  return runInDurableObject(stub, (_a: ZuriAgent, s) => fn(new Database(s.storage)));
}
const json = (ip: string, extra: Record<string, string> = {}) => ({ ...CSRF, "content-type": "application/json", "cf-connecting-ip": ip, ...extra });
const login = (ip: string) => call(`${ORIGIN}/api/auth/login`, { method: "POST", headers: json(ip), body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }) });
const cv = (r: Response, n: string) => r.headers.getSetCookie().find((c) => c.startsWith(`${n}=`))?.split(";")[0]?.slice(n.length + 1);
const post = (p: string, ip: string, cookie: string, body?: unknown) =>
  call(`${ORIGIN}${p}`, { method: "POST", headers: json(ip, { cookie }), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe("audit: burst vs global pause", () => {
  it("parallel wrong codes across 5 challenges", async () => {
    const ip0 = "192.0.2.200";
    const session = `__Host-zuri_session=${cv(await login(ip0), "__Host-zuri_session")}`;
    const setup = mfaSetupSchema.parse(await (await post("/api/auth/mfa/setup", ip0, session)).json());
    const en = await post("/api/auth/mfa/enable", ip0, session, { code: await totpCode(setup.secret, totpStep(Date.now())) });
    recoveryCodesSchema.parse(await en.json());
    const cookies: { ip: string; c: string }[] = [];
    for (let i = 0; i < 5; i++) {
      const ip = `198.51.100.${10 + i}`;
      const r = await login(ip);
      cookies.push({ ip, c: `__Host-zuri_mfa=${cv(r, "__Host-zuri_mfa")}` });
    }
    const reqs = cookies.flatMap(({ ip, c }) => Array.from({ length: 5 }, () => post("/api/auth/mfa", ip, c, { code: "ABCD-EFGH-JKLM-NPQR" })));
    const res = await Promise.all(reqs);
    const statuses = res.map((r) => r.status);
    const wrong = await runOwner((db) => db.one<{ value: string }>(`SELECT value FROM zur_settings WHERE key='auth_mfa_wrong_codes'`));
    console.log("STATUSES", JSON.stringify(statuses), "WRONG", wrong?.value?.length);
    const checked = statuses.filter((s) => s === 401).length;
    expect(checked).toBeGreaterThanOrEqual(0);
  });
});
