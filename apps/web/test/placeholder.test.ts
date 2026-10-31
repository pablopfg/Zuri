import { describe, expect, it } from "vitest";
import { placeholderContent } from "../src/placeholder.ts";

describe("placeholderContent", () => {
  it("comes from the catalog in pt-BR", () => {
    expect(placeholderContent("pt-BR")).toEqual({
      heading: "Zuri",
      lines: ["Seu assistente pessoal de IA, na sua conta Cloudflare.", "Em construção: a interface chega na etapa 5."],
    });
  });

  it("follows the chosen locale", () => {
    expect(placeholderContent("en").lines[1]).toBe("Under construction: the interface arrives in step 5.");
  });
});
