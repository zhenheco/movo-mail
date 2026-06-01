import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

function encodedAbsolutePathResolver(): Plugin {
  return {
    name: "encoded-absolute-path-resolver",
    enforce: "pre",
    resolveId(id) {
      // The worker-pool fallback can hand Vite encoded absolute paths when the
      // repo path contains spaces; decode only existing local files.
      if (id.startsWith("file:")) {
        const filePath = fileURLToPath(id);
        return existsSync(filePath) ? filePath : null;
      }
      if (id.startsWith("/") && id.includes("%")) {
        const filePath = decodeURIComponent(id);
        return existsSync(filePath) ? filePath : null;
      }
      return null;
    },
  };
}

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
  plugins: [encodedAbsolutePathResolver()],
  test: {
    include: ["test/workers/**/*.{test,spec}.ts"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
      },
    },
  },
});
