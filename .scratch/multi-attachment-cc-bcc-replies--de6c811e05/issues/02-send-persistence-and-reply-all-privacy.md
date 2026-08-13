Status: completed

# 02 — Send persistence and Reply All privacy

## What to build

Implement durable send-attempt claiming and the Reply All recipient algorithm across sender, original To/Cc/Bcc, self-removal, duplicate normalization, threading validation, Bcc tri-state confirmation, and privacy-safe message reads.

## Acceptance criteria

- [ ] Reply All includes the original sender, To, Cc, and authoritative Bcc, removes the current user, preserves recipient buckets, and deterministically handles duplicates and empty To.
- [ ] Reply All with unavailable authoritative Bcc requires the exact manual confirmation and typed Bcc fields; known-empty Bcc remains distinguishable from unavailable.
- [ ] Shared viewers cannot read raw Bcc unless authorized; send and search responses preserve the privacy contract.
- [ ] Unauthorized or malformed thread input fails with invalid_thread and never silently sends unthreaded.
- [ ] Retries use atomic send_attempts state and idempotency mismatch returns 409 without a second provider attempt.
- [ ] Focused backend and worker tests are red before implementation and green after implementation.

## Blocked by

- 01-relay-contract-and-attachment-boundary
