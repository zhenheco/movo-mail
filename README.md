# Movo Mail

Internal webmail for Movo, built on Cloudflare Workers. One Worker serves the
HTTP API + the React SPA and also runs as an **Email Worker** that ingests
inbound mail. Storage is D1 (metadata/index), R2 (raw `.eml` + attachments), and
KV (caches/idempotency). The whole app sits behind **Cloudflare Access**.

## Architecture

| Concern        | Tech                                                            |
| -------------- | -------------------------------------------------------------- |
| API + routing  | Hono (TypeScript, strict)                                      |
| Inbound email  | Cloudflare Email Worker + `postal-mime`                        |
| Outbound email | **cf-email relay only** (`CF_EMAIL_ENDPOINT/send`) → MailChannels |
| Auth           | Cloudflare Access JWT verified with `jose`                     |
| Data           | D1 (SQLite) + R2 + KV                                          |
| UI             | React + Vite + Tailwind + shadcn, served via Workers Assets   |
| AI drafts      | Provider hidden behind `src/lib/ai.ts`                         |

> Outbound mail **must** go through the existing cf-email Worter at
> `https://cf-email.zhenhe-co.workers.dev/send`. Never call
> Resend / SES / MailChannels directly from this repo.

## Layout

```
src/
  index.ts            Worker entry: { fetch, email }
  types.ts            All shared types (single source of truth)
  db/index.ts         Typed D1 data-access contract
  lib/cfemail.ts      cf-email relay client
  lib/ai.ts           AI draft-reply contract
  middleware/access.ts Cloudflare Access JWT verification
  email/inbound.ts    Inbound parse → R2 → D1
  api/routes.ts       Hono router (/threads, /message/:id, /search, /send, /ai/draft, /status/:id)
web/                  Vite + React + Tailwind SPA (builds to web/dist)
migrations/           D1 schema (0001_init.sql)
```

## Develop

```bash
npm install
npm run typecheck     # tsc --noEmit (strict)
npm run test          # vitest (workers pool)
npm run build         # vite build → web/dist
npm run dev           # wrangler dev (Worker + assets)
```

## Secrets

Runtime secrets are set per-environment with Wrangler (never committed):

```bash
wrangler secret put CF_EMAIL_API_KEY
wrangler secret put CF_ACCESS_AUD
wrangler secret put CF_ACCESS_TEAM_DOMAIN
wrangler secret put AI_API_KEY
```

`CF_EMAIL_ENDPOINT` is a plain var in `wrangler.toml`. The D1/KV/R2 ids in
`wrangler.toml` are `REPLACE_ME` placeholders — create the resources and fill
them in (`wrangler d1 create`, `wrangler kv namespace create`,
`wrangler r2 bucket create`).

## Migrations

```bash
wrangler d1 migrations apply movo-mail            # local/default
wrangler d1 migrations apply movo-mail --env staging --remote
```

## Deploy

CI (`.github/workflows/deploy.yml`) runs typecheck → test → build on every push
and PR. `main` deploys to **staging**; a published **Release** deploys to
**production** (gated by the `production` GitHub Environment). `CLOUDFLARE_API_TOKEN`
is a GitHub repo secret.

```bash
npm run deploy:staging
npm run deploy:production
```

## Quality gates (from the design spec)

- TypeScript **strict**, no `any`.
- Comprehensive error handling: every external/fetch/DB call in try/catch with
  friendly user-facing messages.
- No hardcoded secrets — config via env bindings only.
- Immutable data patterns; focused files (< 400 lines).

## Secret scanning

This repo relies on the global `gitleaks` pre-commit hook
(`git config --global init.templateDir ~/.git-template`). A repo-local
`.gitleaks.toml` is provided for CI / explicit runs; `gitleaks protect --staged`
runs on every commit.
