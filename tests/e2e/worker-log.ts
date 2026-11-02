import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";

/** Where playwright.config.ts tees the e2e Worker's output (stdout and stderr), from the repository root. */
export const WORKER_LOG = resolve(import.meta.dirname, "../../.wrangler/e2e-worker.log");

/** Lines kept after each uncaught error, for its stack. */
const CONTEXT_LINES = 10;

/**
 * After the run: an exception the Worker never caught fails it, even when every
 * page looked right. workerd only logs these (a stream read after the response
 * went out, a promise nobody awaited), so no test can see them on its own. The
 * check runs before the server stops (Playwright tears down in reverse order).
 */
export default async function checkWorkerLog(): Promise<void> {
  if (!existsSync(WORKER_LOG)) throw new Error(`The Worker's log was not found at ${WORKER_LOG}`);
  // The runtime logs these after the response, so the last request's may still be on its way.
  let size = -1;
  for (let tries = 0; tries < 10 && statSync(WORKER_LOG).size !== size; tries++) {
    size = statSync(WORKER_LOG).size;
    await sleep(300);
  }
  // Without wrangler's colors: an escape code ends in a letter, right before the word.
  const lines = stripVTControlCharacters(readFileSync(WORKER_LOG, "utf8")).split("\n");
  const found = lines.flatMap((line, i) => (/\bUncaught\b/i.test(line) ? [lines.slice(i, i + CONTEXT_LINES + 1).join("\n")] : []));
  if (found.length > 0) {
    throw new Error(`The Worker logged ${found.length} uncaught error(s) during the run (${WORKER_LOG}):\n\n${[...new Set(found)].join("\n\n")}`);
  }
}
