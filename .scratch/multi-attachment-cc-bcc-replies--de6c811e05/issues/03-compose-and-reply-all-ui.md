Status: completed

# 03 — Compose and Reply All UI

## What to build

Expose Cc/Bcc and up to 10 attachments in compose, provide Reply and Reply All flows that carry the contract fields, show the unavailable-Bcc confirmation state, and keep Bcc privacy labels clear for authorized versus shared viewers.

## Acceptance criteria

- [ ] Compose accepts and displays up to 10 attachments with deterministic rejection of the 11th and size overflow.
- [ ] Reply All is available from thread view and populates To/Cc/Bcc according to the backend contract without dropping original recipients.
- [ ] The UI requires explicit confirmation before sending when Reply All Bcc provenance is unavailable and exposes no raw Bcc to unauthorized viewers.
- [ ] UI tests cover compose, Reply, Reply All, Cc/Bcc fields, attachment boundary, and error feedback.
- [ ] Focused web tests are red before implementation and green after implementation.

## Blocked by

- 02-send-persistence-and-reply-all-privacy
