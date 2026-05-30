import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

/**
 * Workers-pool test config: runs tests inside the workerd runtime so Worker
 * bindings (D1/R2/KV) and the email()/fetch() handlers can be exercised
 * realistically. wrangler.toml supplies the binding shapes.
 *
 * Run with: `vitest run --config vitest.workers.config.ts`
 * Place such tests under test/workers/**.
 *
 * NOTE: requires `web/dist` to exist (run `npm run build` first), since
 * wrangler.toml's [assets] directory is validated at startup.
 */
export default defineWorkersConfig({
  test: {
    include: ["test/workers/**/*.{test,spec}.ts"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
      },
    },
  },
});
