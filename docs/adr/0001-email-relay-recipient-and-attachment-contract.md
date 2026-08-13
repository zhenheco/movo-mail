# ADR 0001: Preserve recipient semantics in the canonical email relay

We will extend the canonical `zhenheco/cf-mail` relay contract and implementation to accept one logical send with To, Cc, and Bcc arrays, attachments, threading headers, and idempotency, while keeping Movo Mail's product cap at 10 attachments and honoring Cloudflare's provider limits. We will use the provider's dedicated recipient fields rather than encoding Cc/Bcc as ordinary headers, and we will never fan out a message per recipient. Authoritative original Bcc values may be carried only by explicit Reply All; when they are unavailable, automatic Reply All is blocked and the user must confirm and provide them manually. This preserves threading and idempotency while preventing Bcc disclosure and silent recipient loss; the trade-off is that some Reply All actions require user intervention and the relay repository must be versioned and deployed before Movo can depend on the new contract.

## Integration blocker

The canonical `zhenheco/cf-mail` checkout is outside this Movo worktree and is
not modified by this slice. Movo's local relay client is ready to emit the
versioned recipient, attachment, threading, and Idempotency-Key contract, but
integration and deployment remain blocked until the upstream relay implements
and deploys the matching contract.

## Contract recorded by this slice

- Movo accepts only `contract_version: "movo-send-v1"`; unknown top-level keys
  and `null` fields are rejected before mailbox lookup or relay submission.
- `to`, `cc`, and `bcc` are dedicated `EmailAddress[]` fields. The combined
  Movo limit is 1--50 recipients; invalid address tokens are errors, not
  silently dropped values.
- An attachment is `{filename, contentType, contentBase64, contentId?, inline?}`
  with strict field types, padded standard Base64, and non-zero decoded bytes.
  Movo accepts 0--10 attachments and sums their Base64 characters against the
  5,242,880-character limit. The mapping is `contentType -> type`,
  `contentBase64 -> content`, `inline === true -> disposition: "inline"`, and
  `contentId` is copied only when supplied.
- The local client emits `relay_contract_version: "cf-mail-send-v2"`, maps all
  recipient buckets to the relay's dedicated fields, preserves threading
  headers, and sends `Idempotency-Key` as an HTTP header (never in the JSON
  body). The local relay boundary independently rejects over 50 recipients or
  over 32 attachment entries before making a provider call.
- Focused tests use a stubbed relay only; this slice performs no real email
  delivery. Production remains blocked until the upstream contract is
  versioned, tested, and deployed.
