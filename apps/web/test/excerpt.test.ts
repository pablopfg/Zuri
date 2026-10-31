import { describe, expect, it } from "vitest";
import { plainExcerpt } from "../src/lib/excerpt.ts";

describe("plainExcerpt", () => {
  it("drops headings, list marks, task boxes, quotes and emphasis, and joins the lines", () => {
    expect(plainExcerpt("# Bolo de laranja\n\n- 3 ovos\n- [ ] fermento\n- [x] farinha\n> dica\n1. **Forno** 180 °C `40 min`")).toBe(
      "Bolo de laranja 3 ovos fermento farinha dica Forno 180 °C 40 min",
    );
  });

  it("keeps single * and _ that belong to the text", () => {
    expect(plainExcerpt("nome_do_arquivo e 2*3")).toBe("nome_do_arquivo e 2*3");
  });
});
