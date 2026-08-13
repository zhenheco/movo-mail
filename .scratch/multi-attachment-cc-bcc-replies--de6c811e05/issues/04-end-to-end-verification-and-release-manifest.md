Status: completed

# 04 — End-to-end verification and release manifest

## What to build

Add the complete verification matrix, no-send release manifest, and deployment-facing evidence for the exact candidate. This slice verifies the connected Movo and relay contracts and documents any external upstream deployment prerequisite.

## Acceptance criteria

- [ ] Full test/build/typecheck commands cover the changed backend, worker, and web paths.
- [ ] Boundary, privacy, idempotency, threading, and Reply All cases are represented in the verification matrix.
- [ ] A secret-safe manifest records exact commands, hashes, no-send scope, and deferred authenticated production/browser proof.
- [ ] The release handoff identifies the required relay deployment before Movo production deployment and does not claim a real email send.

## Blocked by

- 03-compose-and-reply-all-ui
