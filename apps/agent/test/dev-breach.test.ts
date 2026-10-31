import { describe, expect, it } from "vitest";
import { DEV_BREACHED_PASSWORD, developmentBreachCheck } from "../src/auth/dev-breach.ts";

describe("the breach check of local development", () => {
  it("answers breached only for its one known phrase, in any case, without the network", async () => {
    expect(await developmentBreachCheck(DEV_BREACHED_PASSWORD)).toBe(true);
    expect(await developmentBreachCheck(DEV_BREACHED_PASSWORD.toUpperCase())).toBe(true);
    for (const other of ["lanterna pomar violeta trapezio", `${DEV_BREACHED_PASSWORD}!`, "", " correct horse battery staple"]) {
      expect(await developmentBreachCheck(other), other).toBe(false);
    }
  });
});
