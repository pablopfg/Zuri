import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The screens that rise into place as a whole (first access, sign-in, lockdown) must stay
// measurable: Chrome never takes text first painted at opacity 0 as the Largest Contentful
// Paint, and Lighthouse then failed with NO_LCP on the first access.
const css = readFileSync(join(import.meta.dirname, "..", "src", "styles.css"), "utf8");

function firstFrame(name: string): string {
  const block = css.match(new RegExp(`@keyframes ${name} \\{\\s*from \\{([^}]*)\\}`));
  if (!block?.[1]) throw new Error(`keyframes ${name} not found`);
  return block[1];
}

describe("rise animation", () => {
  it("starts faintly visible, never fully transparent", () => {
    const opacity = firstFrame("rise").match(/opacity:\s*([\d.]+)/);
    expect(opacity?.[1]).toBeDefined();
    expect(Number(opacity?.[1])).toBeGreaterThan(0);
    expect(Number(opacity?.[1])).toBeLessThanOrEqual(0.05);
  });

  it("is the animation the rising screens use", () => {
    expect(css).toMatch(/--animate-rise: rise /);
  });
});
