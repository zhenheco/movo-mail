# Worker-runtime tests

Tests in this directory run inside **workerd** via
`@cloudflare/vitest-pool-workers` so they can use real Worker bindings
(`DB` / `MAIL_R2` / `MAIL_KV`), call the exported `fetch`/`email` handlers, and
import from `cloudflare:test`.

Run them with:

```bash
npm run build          # required: wrangler validates [assets] = web/dist at startup
npm run test:workers   # vitest run --config vitest.workers.config.ts
```

Plain unit tests that don't need bindings go in `test/**` (top level) and run
under the default `npm run test` (Node environment) — faster, no runtime boot.
