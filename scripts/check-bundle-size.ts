// Fails when the interface's initial JavaScript (the entry script and every
// chunk index.html preloads) grows past the budget of rule P11
// (.claude/rules/performance.md). Run after `npm run build`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

// Ratchet: the size of develop when the check came in. Lower it as the bundle
// shrinks, never raise it without the owner's OK; the target of P11 is 160 kB.
const BUDGET_KB = 175;

const dist = join(import.meta.dirname, "..", "apps", "web", "dist");
const html = readFileSync(join(dist, "index.html"), "utf8");
const files = [
  ...html.matchAll(/<script[^>]+src="\/([^"]+\.js)"/g),
  ...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="\/([^"]+\.js)"/g),
].map((match) => match[1] as string);

if (files.length === 0) {
  console.error("check-bundle-size: no script found in apps/web/dist/index.html");
  process.exit(1);
}

let total = 0;
for (const file of new Set(files)) {
  // Same unit and level as the size Vite prints after the build (kB = 1,000 bytes).
  const kb = gzipSync(readFileSync(join(dist, file)), { level: 9 }).byteLength / 1000;
  total += kb;
  console.log(`${file}: ${kb.toFixed(1)} kB gzip`);
}
console.log(`initial JavaScript: ${total.toFixed(1)} kB gzip (budget ${BUDGET_KB} kB)`);
if (total > BUDGET_KB) {
  console.error(`check-bundle-size: over the budget by ${(total - BUDGET_KB).toFixed(1)} kB (rule P11)`);
  process.exit(1);
}
