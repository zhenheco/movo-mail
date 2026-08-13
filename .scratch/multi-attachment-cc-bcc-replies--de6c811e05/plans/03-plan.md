# TDD plan: Compose and Reply All UI

## Owned paths

`web/src/lib/`, `web/src/components/Compose.tsx`, `web/src/components/ThreadView.tsx`, `web/src/App.tsx`, web types, and web tests.

## TDD steps

1. Write failing component and compose-state tests for Cc/Bcc, Reply All, unavailable-Bcc confirmation, and 10/11 attachment boundaries; run focused tests and capture red.
2. Implement the UI and request wiring against the backend contract; rerun focused tests until green.
3. Refactor only after green, retaining Traditional Chinese labels and accessible controls.

Leave all changes staged and do not run `git commit`; `/go` owns the commit.
