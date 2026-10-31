import { z } from "zod";
import { describe, expect, it } from "vitest";
import { settingsSchema } from "../src/index.ts";

describe("Zod configuration", () => {
  it("is jitless once the package loads, so no page ever probes eval against the CSP", () => {
    expect(z.config().jitless).toBe(true);
    // Parsing still works the same way without the compiled fast path.
    expect(settingsSchema.safeParse({}).success).toBe(false);
  });
});
