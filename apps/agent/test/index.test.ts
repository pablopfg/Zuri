import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";

describe("placeholder worker", () => {
  it("answers 404 without a body and without caching", async () => {
    const response = await worker.fetch(new Request("https://exemplo.com.br/api/health"));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
