// Fails when the interface's initial JavaScript (the entry script and every
// chunk index.html preloads) grows past the budget of rule P11
// (.claude/rules/performance.md). Run after `npm run build`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

// Ratchet: lowered with each PR that shrinks the bundle (175 kB when the check
// came in; 158 kB after the design review left English and the QR and passkey
// code out of the first load; 140 kB once the interface parsed with Zod Mini;
// 139.5 kB once the texts only the server says left the first load; 138.9 kB
// once the home page's title became the greeting, loaded on demand).
// Never raise it without the owner's OK; the ceiling of P11 is 160 kB and its
// goal 150 kB.
const BUDGET_KB = 138.9;

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
const classicZod: string[] = [];
for (const file of new Set(files)) {
  const code = readFileSync(join(dist, file));
  // Classic Zod costs about 18 kB here. It comes back when a schema the first
  // load reaches is built with `zod` instead of `zod/mini`, or when a schema
  // in packages/shared lacks its `/* @__PURE__ */` mark and can't be dropped.
  // The minifier may quote its constructor name with any of the three quotes.
  if (/["'`]ZodType["'`]/.test(code.toString("utf8"))) classicZod.push(file);
  // Same unit and level as the size Vite prints after the build (kB = 1,000 bytes).
  const kb = gzipSync(code, { level: 9 }).byteLength / 1000;
  total += kb;
  console.log(`${file}: ${kb.toFixed(1)} kB gzip`);
}
console.log(`initial JavaScript: ${total.toFixed(1)} kB gzip (budget ${BUDGET_KB} kB)`);
if (classicZod.length > 0) {
  console.error(
    `check-bundle-size: classic Zod is in the first load (${classicZod.join(", ")}). Build what the interface parses with zod/mini and mark every schema in packages/shared with /* @__PURE__ */.`,
  );
  process.exit(1);
}
if (total > BUDGET_KB) {
  console.error(`check-bundle-size: over the budget by ${(total - BUDGET_KB).toFixed(1)} kB (rule P11)`);
  process.exit(1);
}
