# TDD plan: Relay contract and attachment boundary

## Owned paths

`src/lib/cfemail.ts`, `src/api/send.ts`, focused relay contract tests, and contract documentation under `docs/`.

## TDD steps

1. Write failing tests for versioned request validation, Cc/Bcc mapping, Idempotency-Key, 10/11 attachments, 50/51 recipients, and provider wire payload; run the focused tests and capture red.
2. Implement the smallest contract and mapping changes; rerun focused tests until green.
3. Refactor only after green, preserving exact provider field mapping and no-send test doubles.

Leave all changes staged and do not run `git commit`; `/go` owns the commit.
