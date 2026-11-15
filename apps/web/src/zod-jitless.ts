/**
 * zod (a dependency of `@assistant-ui/react`) probes `new Function` the first
 * time it compiles an object schema. Under the strict CSP (decision 0017,
 * `script-src 'self'`) that probe raises a `securitypolicyviolation` even
 * though zod catches it. Jitless mode skips the probe. `main.tsx` imports
 * this module first, before anything that can build a schema.
 */
import { config } from "zod";

config({ jitless: true });
