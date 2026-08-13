# Movo Mail release evidence manifest

Status: **not release-ready**<br>
Review date: 2026-08-14 (Asia/Taipei)<br>
Scope: documentation-only evidence for the exact AutoFlow candidate; no product-code changes are made by this manifest.

## Candidate identity

| Field | Value | Evidence state |
|---|---|---|
| Movo checkout | `/Users/acejou/Documents/Claude Code Projects/.autoflow-wt/2026-08-13-multi-attachment-cc-bcc-replies--de6c811e05` | observed at review time |
| Candidate/source SHA | `2d70ef893fa6f130e767b47b458c13a874bb7a05` | resolved from current `HEAD` at review time |
| Candidate branch | `autoflow/2026-08-13-multi-attachment-cc-bcc-replies--de6c811e05` | observed at review time |
| Upstream `cf-mail` SHA | **unresolved** | private upstream commit was not verified in this worktree |
| Movo deployment SHA/URL | **unresolved** | no deployment was run or claimed |

The SHA above identifies the current candidate source. It is not evidence that the candidate is merged, deployed, or compatible with the upstream relay.

## Exact local commands and evidence

Commands were run from the checkout shown above, with the repository's installed dependencies. All four commands exited `0` on 2026-08-14:

```sh
npm test
npm run typecheck
npm run build
npm run test:workers
```

Observed results:

- `npm test`: 16 test files passed, 255 tests passed.
- `npm run typecheck`: `tsc -p tsconfig.json --noEmit` passed.
- `npm run build`: Vite production build passed and produced `dist/` assets.
- `npm run test:workers`: 1 worker test file passed, 2 tests passed. The installed Workers runtime warned that the requested `2026-01-15` compatibility date is newer than its supported `2024-12-30` date and fell back to `2024-12-30`; this is recorded, not treated as production-runtime proof.

Required final check:

```sh
git diff --check
```

This check is run after this manifest is added. No lint command is defined in `package.json`; lint is therefore unresolved rather than inferred from the passing checks above.

## Verification matrix

The matrix records what the local candidate tests exercise and what remains externally unresolved. “Covered” means local test evidence only; it does not imply deployed-provider or authenticated-browser proof.

| Area | Cases required for release | Local evidence / status |
|---|---|---|
| Attachment boundary | 0, 1, and 10 attachments; 11th rejected atomically; zero-byte, malformed Base64, character-size and serialized-message limits | `test/send.test.ts`, `web/src/components/Compose.test.tsx`; local tests passed. Exact deployed provider byte-limit behavior remains unresolved. |
| Recipient boundary | multiple To/Cc/Bcc, invalid address, combined recipient limit, no silent dropping | `test/send.test.ts`, `web/src/lib/api.test.ts`; local tests passed. Upstream relay limit proof unresolved. |
| Bcc privacy | Bcc stays dedicated; absent from visible headers, `.eml`, send log, audit/error/UI surfaces; owner/shared/unrelated access boundaries | `test/send.test.ts`, `test/api-read.test.ts`, `web/src/lib/compose-reply-all.test.ts`; local tests passed. Authenticated deployed privacy proof deferred. |
| Idempotency | same key and same canonical payload replays one result; same key with changed payload fails closed; concurrent/reconciliation paths do not resend | `test/send.test.ts`, `test/db.test.ts`; local tests passed. Relay-side 24-hour behavior and deployed replay proof unresolved. |
| Threading | Reply and Reply All preserve thread id, `In-Reply-To`, `References`, subject/history; malformed or unauthorized thread fails before relay | `test/send.test.ts`, `test/reply-all.test.ts`, `web/src/lib/compose-reply-all.test.ts`; local tests passed. Deployed relay header mapping unresolved. |
| Reply | sender-only recipient set; no unexpected visible recipients | `test/reply-all.test.ts`, `web/src/lib/compose-reply-all.test.ts`; local tests passed. |
| Reply All | explicit action; sender + visible To/Cc + trusted Bcc; self-removal and case-insensitive deduplication; Bcc remains hidden | `test/reply-all.test.ts`, `web/src/lib/compose-reply-all.test.ts`, `web/src/components/ThreadView.test.tsx`; local tests passed. |
| Reply All Bcc provenance | unavailable Bcc blocks automatic Reply All; exact confirmation plus manual Bcc is required | `test/reply-all.test.ts`, `web/src/lib/compose-reply-all.test.ts`, `web/src/components/Compose.test.tsx`; local tests passed. |
| Persistence / failure | durable claim before relay; failed relay has no sent-copy success; post-provider archive failure is `sent_unarchived` and never resends | `test/db.test.ts`, `test/send.test.ts`, `test/api-read.test.ts`; local tests passed. Live reconciliation proof unresolved. |
| Worker/runtime | API and asset integration under the Workers pool | `npm run test:workers`: passed with the compatibility-date fallback warning noted above. |

## Release boundaries and unresolved prerequisites

1. The canonical upstream `cf-mail` relay must first be versioned, tested, and deployed with `cf-mail-send-v2` support for recipient arrays, attachments, threading headers, and `Idempotency-Key`. Its exact commit, endpoint response, provider-field mapping, and deployed idempotency behavior are **unresolved** here.
2. Movo production must not be deployed against an unverified or incompatible relay. A successful local build, local test suite, or a future Worker deployment alone is not live feature proof.
3. The authenticated Cloudflare Access browser proof is **deferred**: verify the real deployed Movo URL, protected UI route, API behavior, browser console/network behavior, and Bcc redaction using an authorized short-lived session. No browser proof was performed in this review.
4. A controlled delivery probe is **not authorized and not performed**. Any future probe requires an approval record naming an allowlisted disposable recipient/domain, exact payload, purpose, delivery evidence, and cleanup proof.

## No-real-send scope

This review made no external email delivery request and claims no delivery, provider acceptance, sent message, or customer-facing send. The local test suite uses mocks/fixtures and the Workers test pool; it is not a real relay or mailbox delivery test. Keep `CF_EMAIL_API_KEY`, Cloudflare Access credentials, and any other runtime secrets out of evidence, logs, commits, and this manifest.

## Handoff disposition

Local code evidence is green for the commands listed above, but release remains blocked pending upstream `cf-mail` compatibility/deployment evidence, real Movo deployment evidence, and authenticated Cloudflare Access browser proof. This file deliberately records those items as unresolved rather than inventing success.
