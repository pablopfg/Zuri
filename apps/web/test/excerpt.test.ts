import { describe, expect, it } from "vitest";
import { plainExcerpt } from "../src/lib/excerpt.ts";

describe("plainExcerpt", () => {
  it("drops headings, list marks, task boxes, quotes and emphasis, and joins the lines", () => {
    expect(plainExcerpt("# Bolo de laranja\n\n- 3 ovos\n- [ ] fermento\n- [x] farinha\n> dica\n1. **Forno** 180 °C `40 min`")).toBe(
      "Bolo de laranja 3 ovos fermento farinha dica Forno 180 °C 40 min",
    );
  });

  it("keeps the text of links and images, and drops their addresses and HTML tags", () => {
    expect(plainExcerpt('Veja [o site](https://exemplo.com.br) e ![a foto](x.png) <img src=x onerror="alert(1)"> fim')).toBe(
      "Veja o site e a foto fim",
    );
  });

  it("removes nested tags whole and leaves no < or > behind", () => {
    expect(plainExcerpt("a <<script>script>alert(1)<</script>/script> b")).toBe("a alert(1) b");
  });

  it("keeps single * and _ that belong to the text", () => {
    expect(plainExcerpt("nome_do_arquivo e 2*3")).toBe("nome_do_arquivo e 2*3");
  });
});
