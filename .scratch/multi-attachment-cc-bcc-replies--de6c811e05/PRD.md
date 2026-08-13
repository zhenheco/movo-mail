Status: completed

# PRD: Multi-attachment Cc/Bcc Reply All for Movo Mail

## Problem Statement

Movo Mail currently cannot reliably send a thread reply with the original Cc/Bcc recipients, and its Movo-to-relay contract does not provide a durable, verifiable path for multi-recipient messages and attachment boundaries. Bcc is also exposed to shared viewers and the send path lacks the explicit confirmation required when authoritative original Bcc data is unavailable.

## Solution

Implement the versioned Movo send contract and matching relay contract so a message can carry To/Cc/Bcc, up to 10 user attachments, threading metadata, idempotency, and explicit Bcc provenance. Add durable send-attempt state, Reply All recipient reconstruction with self-removal and duplicate handling, privacy-safe Bcc presentation, and a compose/reply UI that supports up to 10 attachments. Release through the handoff-only Go boundary with focused tests and a deployment manifest; no real customer email is sent as part of automated verification.

## User Stories

1. As a mailbox owner, I want to send up to 10 attachments so that I can complete normal multi-file correspondence.
2. As a composer, I want attachment count and size limits enforced before send so that invalid messages fail clearly.
3. As a user replying to a thread, I want Reply All to include the original To, Cc, and authoritative Bcc recipients so that nobody is accidentally omitted.
4. As a shared-mailbox viewer, I want Bcc hidden unless I am authorized so that private recipients stay private.
5. As a sender, I want Reply All blocked when authoritative Bcc is unavailable unless I explicitly confirm typed Bcc fields so that I do not accidentally expose or omit recipients.
6. As a sender, I want duplicate recipients and my own address normalized safely so that the final envelope is deterministic.
7. As a sender, I want retries to be idempotent and durable so that a network retry cannot duplicate delivery.
8. As an operator, I want versioned relay and Movo contracts so that provider limits and field mapping are explicit.
9. As a reviewer, I want deterministic tests for 10/11 attachments, 50/51 recipients, Bcc tri-state, Reply All, privacy, threading, and idempotency.
10. As a release operator, I want a secret-safe manifest with exact hashes and no-send proof so that deployment evidence is auditable.

## Implementation Decisions

- Movo API uses contract_version movo-send-v1 and replyMode new|reply|reply-all.
- Movo accepts at most 10 attachments and 50 combined recipients; the relay accepts at most 32 attachments and 50 combined recipients.
- Attachment mapping is explicit: contentType to type, base64 to content, inline to disposition, contentId preserved.
- Reply All uses the original sender, To, Cc, and authoritative Bcc, removes the current user, preserves visible buckets, promotes a remaining recipient only when To is empty, and de-duplicates deterministically.
- Bcc is tri-state: known-nonempty, known-empty, unavailable. Unavailable Reply All requires the exact manual confirmation literal and typed Bcc fields.
- Durable send_attempts records are claimed atomically; idempotency replay with a different normalized request returns 409.
- Threading is derived only from an owned thread and valid stored Message-ID/References; malformed or unauthorized thread input returns invalid_thread.
- Shared viewers receive redacted Bcc data unless authorization allows the original Bcc.
- Upstream relay and the canonical cf-email skill must be updated when required by the contract; no silent downgrade to a single-To relay.
- Real customer sends are out of the automated test scope.

## Testing Decisions

Tests must observe API/UI behavior and provider wire mapping rather than private implementation helpers. Cover exact lower/upper boundaries, invalid/unauthorized thread, Bcc privacy, reply-all confirmation, retries, idempotency mismatch, and no-send manifest proof. Reuse Vitest worker tests, route tests, and existing compose/thread component tests.

## Out of Scope

- Bulk campaign sending, scheduled mail, provider failover, changing Cloudflare Access roles, and actual customer-email canaries.
- Replacing the relay provider or redesigning unrelated mailbox/inbox features.

## Further Notes

The release is handoff-only: Go produces a pushed candidate and handoff.json; the named release consumer performs merge/deploy/cleanup after all gates. Production browser proof may remain fail-closed at Cloudflare Access if no authenticated session is available.
