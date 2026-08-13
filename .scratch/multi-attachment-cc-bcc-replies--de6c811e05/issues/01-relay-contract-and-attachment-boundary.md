Status: completed

# 01 — Relay contract and attachment boundary

## What to build

Deliver the versioned Movo-to-relay send contract for Cc/Bcc, explicit idempotency headers, threading metadata, attachment mapping, and the 10-attachment Movo boundary. Update the controlled relay integration contract and canonical skill documentation where the existing single-recipient behavior would otherwise reject or drop fields.

## Acceptance criteria

- [ ] Movo validates the versioned request and maps Cc/Bcc, headers, reply metadata, and up to 10 attachments into the relay wire contract without silently dropping fields.
- [ ] Attachment count 10 succeeds and 11 fails; recipient count 50 succeeds and 51 fails; relay-side limits remain explicit at 32 attachments and 50 combined recipients.
- [ ] Idempotency uses the documented request header and provider-facing wire shape is asserted without sending real email.
- [ ] Relay and cf-email skill documentation state the deployed contract and no longer promise single-To-only behavior.
- [ ] Focused tests are red before implementation and green after implementation.

## Blocked by

None - can start immediately
