import { isBreachedPassword } from "@zuri/shared";
import { describe, expect, it } from "vitest";
import { parsePublicUrl } from "../src/config.ts";
import { breachCheckFor, DEV_BREACHED_PASSWORD, developmentBreachCheck } from "../src/auth/dev-breach.ts";

describe("the breach check of local development", () => {
  it("answers breached only for its one known phrase, in any case, without the network", async () => {
    expect(await developmentBreachCheck(DEV_BREACHED_PASSWORD)).toBe(true);
    expect(await developmentBreachCheck(DEV_BREACHED_PASSWORD.toUpperCase())).toBe(true);
    for (const other of ["lanterna pomar violeta trapezio", `${DEV_BREACHED_PASSWORD}!`, "", " correct horse battery staple"]) {
      expect(await developmentBreachCheck(other), other).toBe(false);
    }
  });

  it("is used only on a loopback http address: every other address asks the real service", () => {
    const checkFor = (publicUrl: string) => breachCheckFor(parsePublicUrl(publicUrl)?.allowPlainHttp === true);
    for (const local of ["http://127.0.0.1:8787", "http://localhost:8787", "http://[::1]:8787"]) {
      expect(checkFor(local), local).toBe(developmentBreachCheck);
    }
    for (const deployed of ["https://exemplo.com.br", "http://exemplo.com.br", "https://127.0.0.1", "https://zuri.exemplo.workers.dev"]) {
      expect(checkFor(deployed), deployed).toBe(isBreachedPassword);
    }
  });
});
