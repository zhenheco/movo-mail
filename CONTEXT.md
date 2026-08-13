# Movo Mail: reply recipients and outbound email

## Language

- **Mailbox**: the authenticated Movo Mail mailbox used as the sender and the source of the current user's owned addresses.
- **Visible recipients**: the original message's sender, To, and Cc addresses that are safe to display to ordinary recipients.
- **Authoritative Bcc**: Bcc addresses read from trusted parsed or persisted message data (`bcc_addresses`). It is never inferred from visible headers, delivery metadata, or guesses.
- **Reply**: a response addressed to the original sender only.
- **Reply All**: a response addressed to the original message's sender plus the original visible To/Cc recipients and authoritative original Bcc recipients, after case-insensitive deduplication and removal of the current user's own mailbox addresses.
- **Outbound relay**: the canonical `zhenheco/cf-mail` service that accepts one logical send with To/Cc/Bcc arrays, threading headers, an idempotency key, and attachments.

## Relationships

- A message has one sender, visible recipients, and may have authoritative Bcc recipients. Bcc is a delivery property, not a visible-header property.
- A normal Reply never copies the original To, Cc, or Bcc list automatically.
- Reply All may carry authoritative original Bcc recipients only when those values are available from trusted message data. The Bcc list remains hidden from recipients who are not Bcc recipients.
- If authoritative original Bcc is unavailable, automatic Reply All is blocked. The user may continue only by explicitly confirming and supplying the Bcc recipients manually; the system must not silently send a visible-recipient-only reply.
- A send request is one logical relay operation. It must not fan out into one request per recipient, because that would change threading, delivery semantics, idempotency, and Bcc privacy.
- Movo Mail accepts up to 10 attachments per send and must honor the relay/provider total-message and recipient limits. Validation must fail before relay submission when a limit is exceeded.

## Example dialogue

- User selects **Reply**: To is the original sender; original To/Cc/Bcc are not copied by default.
- User selects **Reply All** and authoritative Bcc is present: To/Cc/Bcc are populated from the approved recipient sets, self-addresses are removed, and Bcc stays in the Bcc field.
- User selects **Reply All** and authoritative Bcc is absent: the UI explains that the original Bcc cannot be verified and prevents automatic send until the user explicitly confirms and enters Bcc recipients.

## Flagged ambiguities

- “回覆” means the sender-only Reply action; “回覆全部” means the explicit Reply All action. They must not share a silent recipient-expansion rule.
- “原始 Bcc” means authoritative parsed or persisted Bcc values only. It does not mean addresses inferred from the original raw header, visible recipient list, or delivery results.
- The product limit is 10 attachments even if the provider exposes a higher attachment-count limit; the complete encoded message size remains governed by the relay/provider contract.
