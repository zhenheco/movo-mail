import { defineConfig } from "vitest/config";

/**
 * Default test config (plain Node environment) — fast, no Worker runtime.
 * Most unit tests (parsing, pure helpers, type contracts) run here.
 *
 * Tests that need real Worker bindings (D1/R2/KV, the email() handler, fetch
 * against the Hono app) should run under the workers pool via:
 *   `vitest run --config vitest.workers.config.ts`
 * The workers pool boots workerd and reads wrangler.toml for binding shapes.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.{test,spec}.ts", "src/**/*.{test,spec}.ts"],
    exclude: ["test/workers/**", "node_modules/**"],
    environment: "node",
  },
});
