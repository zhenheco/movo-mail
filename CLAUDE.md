# Movo Mail

Cloudflare Worker webmail for `@movo.com.my`. Identity = World-B (personal Gmail via Cloudflare Access; `mailboxes.owner_id ↔ users.email`). See `docs/2026-06-03-uat-pre-onboarding.md`.

## Agent skills

### Issue tracker

Issues and PRDs live as markdown under `.scratch/<feature-slug>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical roles map 1:1 to their default strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at repo root (created lazily). See `docs/agents/domain.md`.
