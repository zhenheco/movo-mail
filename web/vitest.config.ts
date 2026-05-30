import { defineConfig } from "vitest/config";

// Vitest config for the web SPA's pure-function unit tests. These run in the
// node environment (no DOM needed) — the api client, formatting, and compose
// helpers are all pure. Run with: npx vitest run --config web/vitest.config.ts
export default defineConfig({
  test: {
    environment: "node",
    include: ["web/src/**/*.test.ts", "web/src/**/*.test.tsx"],
    globals: true,
  },
});
