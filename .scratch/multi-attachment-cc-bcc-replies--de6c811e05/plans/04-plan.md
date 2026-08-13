# TDD plan: End-to-end verification and release manifest

## Owned paths

`docs/verification/`, release evidence/manifest files, and only tests needed to close the complete candidate matrix.

## TDD steps

1. Write failing verification assertions for the contract matrix and no-send manifest; run them and capture red.
2. Implement the evidence generator/checks and close only the missing acceptance cases; rerun focused tests until green.
3. Refactor after green and record exact command/hash evidence.

Leave all changes staged and do not run `git commit`; `/go` owns the commit.
