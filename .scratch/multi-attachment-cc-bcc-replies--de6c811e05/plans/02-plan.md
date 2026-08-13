# TDD plan: Send persistence and Reply All privacy

## Owned paths

`migrations/`, `src/db/`, `src/api/send.ts`, `src/types.ts`, `src/lib/reply-all.ts`, and backend/worker tests.

## TDD steps

1. Write failing tests for Reply All bucket semantics, self-removal, duplicate normalization, Bcc tri-state confirmation, shared-viewer redaction, invalid thread, atomic send_attempts, replay mismatch, and exactly-once provider attempt; run the focused tests and capture red.
2. Implement schema, service, and API behavior with fail-closed errors; rerun focused tests until green.
3. Refactor only after green and ensure all external calls have explicit error handling.

Leave all changes staged and do not run `git commit`; `/go` owns the commit.
