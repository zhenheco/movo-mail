# Movo Mail multi-attachment and Reply All recipients — SPEC

## Problem Statement

When a user composes or replies to an email in Movo Mail, the UI and relay path do not preserve the complete recipient set. Reply only targets the sender, there is no explicit Reply All action, Cc/Bcc cannot be edited consistently, and the current relay adapter collapses multiple To recipients to one address. Attachments appear to support multiple files in the browser, but the end-to-end contract is not proven for the 10-file boundary. This can silently omit recipients, lose threading metadata, expose or mis-handle Bcc, or make a user believe that multiple attachments were sent when the relay ignored them.

## Solution

Users can add up to 10 attachments to a new message or reply and see validation before sending. The compose surface exposes To, Cc, and Bcc as separate recipient fields and sends one logical message through the canonical cf-mail relay with all recipient arrays, threading headers, attachments, and one idempotency key. Reply remains sender-only; Reply All is explicit and includes the original sender, visible To/Cc recipients, and authoritative original Bcc recipients with case-insensitive deduplication and self-address removal. If trusted original Bcc data is unavailable, automatic Reply All is blocked and the user must explicitly confirm and manually supply Bcc recipients; the system never silently sends a visible-recipient-only Reply All.

## User Stories

1. As a mailbox user, I want to attach multiple files to a new message, so that I can send a complete document package in one email.
2. As a mailbox user, I want to attach up to 10 files, so that the product supports the requested maximum without requiring separate messages.
3. As a mailbox user, I want the 11th attachment to be rejected before sending, so that I receive a clear error instead of a partial or ambiguous send.
4. As a mailbox user, I want total attachment/message-size validation before sending, so that provider-size failures are caught locally.
5. As a mailbox user, I want to enter multiple To recipients, so that one logical message reaches all intended primary recipients.
6. As a mailbox user, I want separate Cc and Bcc fields, so that visible and hidden recipients retain their intended semantics.
7. As a mailbox user, I want invalid recipient input to be rejected rather than silently discarded, so that I can correct the actual message before sending.
8. As a mailbox user, I want Reply to address only the original sender, so that a normal reply does not unexpectedly disclose the conversation to other recipients.
9. As a mailbox user, I want an explicit Reply All action, so that recipient expansion is intentional and visible in the compose form.
10. As a mailbox user, I want Reply All to include the original sender and original visible To/Cc recipients, so that the conversation continues with everyone who was visibly included.
11. As a mailbox user, I want Reply All to include authoritative original Bcc recipients when available, so that the original hidden recipients are preserved as requested.
12. As a mailbox user, I want my own mailbox addresses removed from Reply All, so that I do not send a redundant copy to myself.
13. As a mailbox user, I want duplicate recipient addresses deduplicated case-insensitively across To/Cc/Bcc, so that a person does not receive duplicate copies.
14. As a mailbox user, I want Reply All to preserve Bcc as hidden delivery recipients, so that Bcc addresses are never placed in visible headers or shown to other recipients.
15. As a mailbox user, I want automatic Reply All blocked when original Bcc cannot be verified, so that the system does not silently lose hidden recipients.
16. As a mailbox user, I want to explicitly confirm and manually enter Bcc when the original Bcc is unavailable, so that I can still send an intentional message after reviewing the missing provenance.
17. As a mailbox user, I want replies to preserve In-Reply-To and References, so that recipients' mail clients keep the message in the correct conversation.
18. As a mailbox user, I want replies with attachments to retain their recipient and threading semantics, so that attachments do not turn a reply into an unrelated message.
19. As a mailbox user, I want a failed relay request to produce no sent-copy success, so that UI status reflects the actual send outcome.
20. As a mailbox user, I want retrying with the same idempotency key not to send duplicates, so that network retries are safe.
21. As a mailbox owner, I want my sent copy to retain its Bcc data for my own future Reply All operation, so that trusted provenance is not lost after sending.
22. As a mailbox owner, I want shared-mailbox permissions and the server-selected From address to remain enforced, so that recipient enhancements cannot send as an unauthorized mailbox.
23. As a mailbox owner, I want the relay contract to use one logical send rather than per-recipient fan-out, so that threading, idempotency, and Bcc privacy remain consistent.
24. As an operator, I want the cf-mail relay contract and Movo adapter tested at their boundaries, so that deployment does not depend on an untested provider serialization assumption.
25. As an operator, I want production smoke checks to verify the deployed API and UI without sending real customer email, so that release verification is safe and evidence-based.

## Modules

| Module | 職責（一句） | 公開介面（窄） | 新建/修改 |
|---|---|---|---|
| Server send validation | Normalize and validate To/Cc/Bcc and attachment arrays, enforce the 10-file and total-size limits, and reject invalid entries before relay submission. | `validateSendBody(input) -> ValidatedBody \| error` | 修改 `src/api/send.ts` |
| Recipient semantics | Build sender-only Reply and explicit Reply All recipient sets from trusted message data, removing self addresses and deduplicating case-insensitively. | `replyDraft(message)` / `replyAllDraft(message, ownAddresses) -> ComposeDraft` | 修改 `web/src/lib/compose.ts` |
| Compose state and controls | Expose separate To/Cc/Bcc inputs, Reply/Reply All mode, attachment selection, manual Bcc confirmation, and pre-send errors. | `Compose` props and local form handlers | 修改 `web/src/components/Compose.tsx` |
| Thread actions | Display visible recipient metadata and expose Reply and Reply All actions with the original message context. | `ThreadView` action callbacks | 修改 `web/src/components/ThreadView.tsx` |
| App reply orchestration | Connect thread actions to compose drafts and pass the current user's mailbox addresses for self-filtering/provenance decisions. | `handleReply` / `handleReplyAll` | 修改 `web/src/App.tsx` |
| Web API types | Mirror server Bcc, Reply All, typed provenance, and versioned send payloads without importing Worker-only types into the browser bundle. | `SendRequest`, `ComposeDraft`, `MessageWithAttachments` | 修改 `web/src/lib/types.ts` |
| Movo cf-mail adapter | Serialize one logical send with To/Cc/Bcc arrays, attachments, threading headers, and an HTTP idempotency header; preserve Bcc only in the dedicated field. | `sendViaCfEmail(env, req) -> SendResult` | 修改 `src/lib/cfemail.ts` |
| Outbound persistence | Persist sent-copy To/Cc/Bcc and attachments while keeping Bcc out of visible `.eml` headers and send logs. | `insertOutboundMessage(input)` | 修改 `src/db/index.ts` / `src/api/send.ts` only as needed |
| Canonical cf-mail `/send` contract | Validate and forward recipient arrays, attachments, custom threading headers, and `Idempotency-Key` to the Cloudflare Email Service binding in one send. | `POST /send` JSON contract | 修改 upstream `zhenheco/cf-mail` repo |
| Relay skill contract | Document the deployed relay request/limit/idempotency contract so future Movo adapters do not rely on stale single-To or “attachments unsupported” guidance. | cf-email skill reference | 修改 `/Users/acejou/Documents/CC Cli/agents-skills/cf-email-sdk/SKILL.md` if upstream contract changes |

## Implementation Decisions

- Schema: existing message `to_addresses`, `cc_addresses`, and `bcc_addresses` JSON fields remain the source for persisted recipient provenance; persist an explicit empty Bcc as `[]`, never `NULL`, when the source was inspected and known-empty. Add a durable `send_attempts` table keyed by `(mailbox_id, idempotency_key)` with the states and atomic transitions defined in the normative addendum; it is required for local replay/reconciliation and is not optional.
- API contract: Movo `POST /api/send` uses `contract_version: "movo-send-v1"` and the exact request/response/error contract in the normative addendum. The canonical relay `POST /send` uses `relay_contract_version: "cf-mail-send-v2"`, To/Cc/Bcc arrays, `from`, subject/body, attachments, custom `In-Reply-To`/`References` headers, and one `Idempotency-Key` HTTP header. The relay response maps `{id,status,messageId}` to Movo's success envelope; a missing or incompatible relay version is a fail-closed deployment error.
- Architecture: keep the canonical `zhenheco/cf-mail` service as the only outbound provider and send one logical request. Do not fan out per recipient, because fan-out breaks provider-level threading, idempotency, and Bcc privacy.
- Recipient semantics: Reply is sender-only. Reply All is explicit, uses authoritative persisted/parsed Bcc when present, merges original sender and visible To/Cc, removes the current user's owned addresses, and deduplicates case-insensitively. Missing authoritative Bcc blocks automatic Reply All; manual Bcc entry requires an explicit user confirmation.
- Provider integration: the relay wire body is `{to: string|string[], cc?: string|string[], bcc?: string|string[], from: string, subject: string, text?: string, html?: string, headers?: Record<string,string>, attachments?: Array<{filename:string,type:string,content:string,disposition:"attachment"|"inline",contentId?:string>}, tags?: string[]}`; the relay calls `env.EMAIL.send` exactly once with the same dedicated `to`, `cc`, `bcc`, `from`, body, `headers`, and attachment fields and returns the binding's `messageId`. Never encode Cc/Bcc as ordinary visible headers. Honor the provider's combined-recipient and message-size limits while keeping Movo's attachment-count cap at 10.
- Security/permissions: keep Cloudflare Access and mailbox ownership enforcement unchanged; force the authenticated mailbox as From and ignore any client-supplied From for authorization; reject invalid recipient entries instead of filtering them silently; owner-scoped authoritative Bcc may be used only by the owner/sender, while shared viewers receive redacted Bcc and cannot auto-populate it; never include Bcc in visible `.eml` headers, non-owner UI/API summaries, audit details, or `send_log.to_addresses`; never log attachment contents or API keys.
- Boundaries/performance: reject attachment count >10, attachment base64 characters greater than 5,242,880, complete serialized message bytes greater than the provider limit, invalid base64, zero-byte files, empty bodies, invalid addresses, and provider recipient-limit overflow before relay submission. Convert attachment files once and send them in one request. Preserve the current best-effort R2 sent-copy behavior without claiming archival success when R2 fails; a post-provider persistence failure records `sent_unarchived` and reconciles without another relay call.
- Idempotency: send the same generated/request idempotency key in the relay's `Idempotency-Key` header; include server-derived mailbox/thread identity, all recipient arrays, threading headers, body, and attachments in the Movo and upstream canonical hash so a changed retry fails closed rather than sending a different message. A durable local claim is atomic before the provider call.
- Deployment boundary: upstream cf-mail must be versioned, tested, and deployed before Movo production points at the expanded contract. If the private upstream cannot be changed in the same controlled release, stop before deploying Movo code that would send unsupported fields.

## Testing Decisions

| Module | 要測? | 測什麼外部行為 | Prior art（既有同類測試） |
|---|---|---|---|
| Server send validation | ✅ | accepts 1–10 attachments, rejects 11 and size overflow, preserves all valid To/Cc/Bcc, rejects malformed entries, and does not call relay on invalid input | `test/send.test.ts` |
| Movo cf-mail adapter | ✅ | sends arrays and attachments in one JSON body, forwards threading headers, sends `Idempotency-Key`, and preserves Bcc as a dedicated field | `test/send.test.ts` / `web/src/lib/api.test.ts` |
| Recipient semantics | ✅ | Reply is sender-only; Reply All merges trusted recipients, removes self, deduplicates, carries Bcc, and blocks/flags unavailable Bcc | `web/src/lib/api.test.ts` |
| Compose state and controls | ✅ | To/Cc/Bcc controls round-trip, Reply All warning/confirmation is enforced, attachment boundary messages are visible, and successful submit sends one request | existing web component tests plus `web/src/lib/api.test.ts` |
| Thread actions and App orchestration | ✅ | Reply and Reply All actions open the correct draft and preserve mailbox/thread context | `web/src/lib/selection.test.ts` / `web/src/lib/api.test.ts` |
| Persistence and Bcc secrecy | ✅ | sent copy persists Bcc for owner-only future use, visible `.eml` omits Bcc, send log does not leak Bcc, and attachments remain linked | `test/api-read.test.ts` / `test/send.test.ts` |
| Canonical cf-mail `/send` | ✅ | accepts arrays, max 10 attachments, idempotent replay/mismatch, custom threading headers, provider field mapping, and rejects malformed recipient/attachment input | upstream `test/send.test.ts` / `test/idempotency.test.ts` |
| Skill contract | ✅ | documented endpoint fields, limits, idempotency, and deployment commands match the canonical relay implementation and Movo adapter | skill smoke/read-back plus repository diff review |
| Release smoke | ✅ | production health/API reachability and authenticated UI route behavior are verified without sending real customer mail; controlled test send is only performed with explicit approval | deployment/runbook probes |

## Vertical Slices

### Slice 1 — Canonical relay recipient and attachment contract

- **Type**: AFK
- **Blocked by**: None
- **User stories**: #1, #5, #6, #19, #20, #23, #24
- **Acceptance criteria**:
  - [ ] cf-mail `/send` accepts To/Cc/Bcc arrays and forwards them through one Cloudflare Email Service binding call.
  - [ ] cf-mail accepts attachment arrays, rejects malformed values, accepts 10, rejects 11, and enforces the documented total-message limit.
  - [ ] cf-mail forwards `In-Reply-To` and `References` as custom headers and uses `Idempotency-Key` for replay/mismatch behavior.
  - [ ] Movo's adapter emits the expanded contract and preserves Bcc without putting it into ordinary headers.
  - [ ] Upstream and Movo focused tests pass, including provider payload assertions and idempotency cases.

### Slice 2 — Server validation, persistence, and privacy

- **Type**: AFK
- **Blocked by**: Slice 1
- **User stories**: #3, #4, #7, #14, #21, #22
- **Acceptance criteria**:
  - [ ] Movo rejects invalid recipients/attachments and the 11th attachment before relay submission.
  - [ ] Movo sends all valid recipient arrays and up to 10 attachments without truncation.
  - [ ] Existing mailbox ownership, Access, rate-limit, suppression, and idempotency behavior remains enforced.
  - [ ] Sent copies persist To/Cc/Bcc for the owner, while visible `.eml` output and send logs do not expose Bcc.
  - [ ] Server tests prove the negative privacy and no-partial-send paths.

### Slice 3 — Compose Cc/Bcc and multi-attachment UI

- **Type**: AFK
- **Blocked by**: Slice 2
- **User stories**: #1, #2, #3, #4, #5, #6, #7, #18
- **Acceptance criteria**:
  - [ ] New messages and replies show separate To, Cc, and Bcc controls and serialize each field correctly.
  - [ ] The file picker accepts multiple files up to 10 and shows a clear rejection for the 11th or size overflow.
  - [ ] The send button does not submit while recipient/attachment validation errors remain.
  - [ ] A valid send submits one request containing all recipients, attachments, threading metadata, and idempotency.
  - [ ] UI tests cover empty/duplicate/invalid recipient input and exact attachment boundaries.

### Slice 4 — Explicit Reply All with Bcc provenance guard

- **Type**: AFK
- **Blocked by**: Slice 3
- **User stories**: #8, #9, #10, #11, #12, #13, #14, #15, #16, #17, #18
- **Acceptance criteria**:
  - [ ] Reply continues to target only the original sender.
  - [ ] Reply All is a separate action and fills original sender plus visible To/Cc and authoritative Bcc, removing self and case-insensitive duplicates.
  - [ ] Bcc remains in the Bcc field and is not rendered as a visible To/Cc recipient.
  - [ ] When authoritative original Bcc is absent, Reply All is blocked with an explanation and cannot send until the user explicitly confirms and manually enters Bcc.
  - [ ] Reply and Reply All preserve thread id, In-Reply-To, References, subject, and history.
  - [ ] UI and API tests cover available/unavailable Bcc and mixed-case duplicate addresses.

### Slice 5 — Release verification and contract documentation

- **Type**: HITL
- **Blocked by**: Slice 4
- **User stories**: #24, #25
- **Acceptance criteria**:
  - [ ] The cf-email skill documents the deployed relay contract, limits, idempotency, and deployment/migration commands accurately.
  - [ ] Movo typecheck, unit/worker tests, build, lint/diff checks, and destructive QA pass.
  - [ ] The upstream relay and Movo deployments are independently verified at their real endpoints.
  - [ ] Production health and Access-protected UI/API smoke evidence is captured without sending customer email.
  - [ ] Any controlled test send uses disposable/test recipients and explicit user authorization; otherwise release stops before send.

## Out of Scope

- Replacing Cloudflare Email Service or the canonical cf-mail provider.
- Sending one copy per recipient or otherwise fanning out a logical message.
- Increasing the Movo product attachment cap above 10.
- Inferring missing Bcc addresses from visible headers, delivery metadata, or message body content.
- Automatically sending Reply All when authoritative original Bcc is unavailable.
- Redesigning mailbox permissions, Cloudflare Access onboarding, shared-mailbox assignment, or the existing thread model.
- Adding a new attachment storage provider or changing R2 archival semantics beyond what is required for the sent-copy behavior.
- Sending real customer-facing test emails as part of automated deployment verification.

## Further Notes

- The current Movo checkout already has a 10-attachment UI/server boundary and persisted Bcc columns, but the relay adapter collapses To to one address and does not serialize Cc/Bcc. The implementation must close that full-chain gap rather than only change the UI.
- The canonical upstream repository is private and its current main commit was inspected read-only. Its current tests skip the real `EMAIL.send` path, so provider payload mapping requires explicit contract tests and a safe deployed smoke check.
- Cloudflare's current Workers API supports structured To/Cc/Bcc, custom headers, attachments, and a combined recipient limit; the implementation must use those dedicated fields and remain within the provider's complete message-size limit. See the official [Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/) and [recipient fields](https://developers.cloudflare.com/email-service/examples/email-sending/recipients/).
- Movo production uses Cloudflare Worker environments. Deploy only after upstream contract compatibility is confirmed; a successful build or worker deployment alone is not live feature proof.
- The final release report must distinguish code/test proof, upstream deployment proof, Movo deployment proof, authenticated Access proof, and controlled delivery proof.
## Normative contract addendum

The following rules are normative and resolve any earlier less-specific wording.

### Public request, response, and error contract

Movo POST `/api/send` accepts exactly the versioned JSON object `{contract_version:"movo-send-v1",from?:EmailAddress,to:EmailAddress[],cc?:EmailAddress[],bcc?:EmailAddress[],subject:string,text?:string,html?:string,attachments?:Attachment[],headers?:Record<string,string>,threadId?:string,mailboxId?:string,idempotencyKey?:string,replyMode?:"new"|"reply"|"reply-all",bccProvenance?:"known-nonempty"|"known-empty"|"unavailable",bccConfirmation?:"confirmed-missing-original-bcc"}`. Unknown keys are rejected; `null` is rejected for every field; `from` is accepted only for backward compatibility and never authoritative. `to` is non-empty; `text` or `html` is required; `replyMode`, `bccProvenance`, and `bccConfirmation` are required together for Reply All and omitted for new/Reply. EmailAddress is `{address:string,name?:string}` with no additional keys; `name` is optional non-blank string. Addresses use the existing bare-address grammar, are trimmed, and invalid tokens are errors rather than silently dropped. `from` is always server-derived from the authenticated mailbox.

An attachment is `{filename:string,contentType:string,contentBase64:string,contentId?:string,inline?:boolean}` with no additional keys. Filename/contentType are non-blank strings, `inline` is boolean when present, contentId is non-blank when present, and contentBase64 is standard padded Base64 decoding to at least one byte. The Movo-to-relay mapping is `contentType→type`, `contentBase64→content`, `inline===true→disposition:"inline"`, otherwise `"attachment"`; `contentId` is copied only when present. An 11-file picker batch is atomic.

Success is HTTP 200 `{ok:true,id:string,status:"queued"|"pending"|"sent"|"sent_unarchived",messageId:string|null}`. Validation is HTTP 400 `{error:string,code:string}`; stable codes are `invalid_request`, `invalid_recipient`, `recipient_limit`, `invalid_attachment`, `attachment_limit`, `message_size_limit`, `missing_body`, `invalid_thread`, `reply_all_no_recipients`, and `reply_all_bcc_confirmation_required`. Authorization is 403 `mailbox_forbidden`, suppression is 422 `recipient_suppressed`, idempotency mismatch is 409 `idempotency_mismatch`, and upstream or network failure is 502 `relay_unavailable`. The relay accepts the exact relay wire object above plus the `Idempotency-Key` header and `X-API-Key`, and returns `{id:string,status:"pending"|"sent"|"failed",messageId?:string}` or `{error:{code:string,message:string}}`. Error precedence is JSON shape/unknown keys/nulls, recipient grammar/count after normalization, attachment grammar/count, Base64 decode/non-zero, attachment Base64 character total, complete serialized message bytes, mailbox/thread authorization, idempotency claim, then relay submission; the first failing rule wins.

### Numeric boundaries and byte accounting

Movo accepts 1 through 50 combined To, Cc, and Bcc recipients. Exactly 50 passes and 51 fails before any relay call. Movo accepts 0 through 10 attachments. Exactly 10 passes and 11 fails. The relay contract independently accepts 1 through 50 combined recipients and 0 through 32 attachment entries; its fixtures assert 50/51 and 32/33. Movo never sends more than 10 attachment entries.

Movo sums normalized attachment `contentBase64` character lengths and rejects totals greater than 5,242,880 characters. Valid padded Base64 lengths are multiples of four, so exact 5,242,880 passes and the smallest valid over-limit fixture is 5,242,884. `RelayMessageBytes` is the deterministic UTF-8 MIME serialization of the exact relay payload (fixed header order, CRLF separators, fixed multipart boundary, normalized Base64, no transport compression); the default provider ceiling is 5,242,880 bytes, with exact and one-byte-over serialized fixtures. The 25 MiB verified-destination allowance is not assumed.

Every boundary rejection asserts stable error code, zero provider calls, and no message or send-log write. Fixtures cover zero-byte content rejection, one byte, exact limits, and the smallest valid over-limit Base64 fixture.

### Reply All algorithm and Bcc provenance

Reply All source order is original sender, original To order, original Cc order, then original Bcc order. Addresses are trimmed and compared case-insensitively. Remove all current user owned mailbox addresses before assigning recipients. The sender bucket is To; original To remains To, original Cc remains Cc, and original Bcc remains Bcc. If the sender bucket is empty after self-removal, promote the first remaining original To, then Cc, then Bcc address into To and keep all other addresses in their original buckets. If none remains, use `reply_all_no_recipients` and do not call the relay. Reply is sender-only.

An address first seen in visible To or Cc wins over a later Bcc occurrence, so it is never promoted into Bcc or duplicated.

Bcc provenance is tri-state: known-nonempty is trusted persisted owner-scoped `bcc_addresses` with values; known-empty is trusted message data explicitly inspected with an empty Bcc list; unavailable means no trusted source exists or sources conflict. Persisted owner data precedes trusted ingest parser data. Raw visible headers, delivery metadata, client history, and inference are never sources. A manual unavailable-Bcc send must carry `replyMode: "reply-all"`, `bccProvenance: "unavailable"`, `bccConfirmation: "confirmed-missing-original-bcc"`, and at least one valid submitted Bcc address; a standalone boolean is rejected.

The mailbox owner or sender may use authoritative Bcc. A non-owner shared-mailbox viewer sees a redacted Bcc value and cannot auto-populate it; Reply All is disabled for that viewer unless the typed manual path is used. `known-nonempty` carries dedicated Bcc; `known-empty` permits Reply All with no Bcc; `unavailable` shows a warning, keeps automatic send disabled, and enables send only after the exact typed confirmation plus manual Bcc entry.

### Idempotency, threading, and persistence

The client creates one key per logical send and retains it across retries. The adapter sends it unchanged in `Idempotency-Key`; the relay scopes it to the API key and retains it for 24 hours. Movo's durable `send_attempts` table has `id`, `mailbox_id`, `idempotency_key`, `canonical_hash`, `provider_id`, `message_id`, `status`, `error`, `created_at`, `updated_at`, a unique `(mailbox_id,idempotency_key)`, and a unique `(mailbox_id,idempotency_key,canonical_hash)` claim. Allowed transitions are `queued→pending→sent|failed|sent_unarchived`; replay of the same hash returns the stored response; a different hash returns HTTP 409 with no provider call. The atomic claim and transition happen before the provider call, and reconciliation uses provider id/status plus the same local row—never a second call for `sent_unarchived`.

Concurrent same-key requests produce one call and one delivery with the same provider id. Timeout before provider acceptance returns 502 and same-key retry is safe only after the local `pending` row is reconciled against relay status; a pending claim is never blindly resent. If provider acceptance occurs but the response is lost, relay status polling or same-key replay returns the same provider id and exactly one complete sent copy or an explicit `sent_unarchived` state. Delivery success with D1 or R2 failure never reports complete archival success and cannot send again.

Reply and Reply All preserve server-derived thread id, one `Re:` subject prefix, In-Reply-To, References, and AI history. A valid owned thread uses the latest valid stored Message-ID for In-Reply-To and a References list consisting of prior valid references followed by that latest ID; if there are no prior valid references, References contains the latest ID. Malformed stored references are discarded, and an unauthorized or malformed explicit thread id returns `invalid_thread` before relay submission. Client-supplied threading headers are ignored.

### Observable privacy and release evidence

The owner, authorized shared viewer, and unrelated-user matrix covers GET /api/message/:id, thread and UI summaries, generated eml, send_log, audit detail, error body, and browser console. Bcc is present only in the owner-scoped authoritative source and dedicated relay payload, and absent from every other surface.

Each invalid or provider-boundary case records HTTP status, stable error, provider call count, D1 or R2 write count, and UI send state. The provider sink records one full payload and one call for valid sends.

The immutable release evidence is `artifacts/release-evidence.json` with exact schema `{schema_version:1,utc_timestamp:string,upstream:{commit:string,endpoint:string},movo:{commit:string,endpoint:string},auth:{health:"passed"|"failed",ui:"passed"|"failed"},compatibility:{request_sha256:string,response_sha256:string,relay_contract_version:string,movo_contract_version:string,version_skew:"none"|"detected"},rollback:{upstream_commit:string,movo_commit:string},commands:Array<{command:string,exit_code:number,stdout_sha256:string,stderr_sha256:string}>,no_send:{scope:string,from:string,to:string,provider_calls:number,delivery_count:number,observed_at:string}}`; hash scope is canonical UTF-8 JSON of the file with `manifest_sha256` omitted, and the final manifest records `manifest_sha256` plus immutable deployed commit SHAs. The compatibility probe calls the deployed Movo route through the real relay version endpoint or a fail-closed binding sink; the no-send oracle covers the exact UTC window and both counters must be zero. Destructive QA uses isolated fixtures only.

A real delivery probe is a separate HITL gate and requires an approval record naming an allowlisted disposable recipient or domain, exact payload, purpose, delivery evidence, and cleanup proof. Without that record, deployment verification sends no email.
