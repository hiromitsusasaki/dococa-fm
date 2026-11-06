import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Workers AI is remote-only (vitest.config.ts turns remote bindings off, so the binding only throws): tests run as if
// it were not bound, and the ones that need vectors hand in a fake `AI`.
delete (env as { AI?: unknown }).AI;
