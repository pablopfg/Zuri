import { config } from "zod";

// Zod compiles fast object parsers with `new Function` unless told not to, and
// probes for it on the first object schema. The interface's CSP (script-src
// 'self', no 'unsafe-eval') and workerd both refuse eval, so the probe only
// fails, logs a CSP violation in the browser and leaves the slow path anyway.
// Must run before any schema is built: index.ts imports this file first.
config({ jitless: true });
