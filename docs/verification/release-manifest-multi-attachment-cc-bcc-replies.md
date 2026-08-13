# Movo Mail release evidence manifest

Status: **production-verified (worker/curl + authenticated Access browser evidence; no-real-send)**<br>
Review date: 2026-08-14 (Asia/Taipei)<br>
Scope: documentation-only evidence for the exact AutoFlow candidate; no product-code changes are made by this manifest.

## Candidate identity

| Field | Value | Evidence state |
|---|---|---|
| Movo checkout | `/Users/acejou/Documents/Claude Code Projects/.autoflow-wt/2026-08-13-multi-attachment-cc-bcc-replies--de6c811e05` | observed at review time |
| Candidate/source SHA | `83fadbe8c5534d5998b83c6a08b92b8765a415c0` | exact deployed Movo candidate |
| Candidate branch | `autoflow/2026-08-13-multi-attachment-cc-bcc-replies--de6c811e05` | observed at review time |
| Upstream `cf-mail` SHA | `5c931cd86c170cf048d4ce9e0d95dbc265fa3d86` | exact deployed relay candidate |
| Relay deployment | `02493f59-2583-4e15-b6fb-a78b406f2eba` | `https://cf-email.acejou27.workers.dev/healthz` returned 200 |
| Movo staging deployment | `e6147a95-cc8d-4849-9de2-ab561f1a273f` | `https://movo-mail-staging.acejou27.workers.dev/healthz` returned 200 |
| Movo production deployment | `e9774d97-8bd1-4fa8-8bf6-efe8f212ffe7` | worker health/home/API smoke passed; authenticated Access UI smoke passed |
| Production rollback target | `e1c3ed08-a16c-4e6f-b05b-e5c6009c0b55` | captured before deployment |

The SHAs above identify the exact candidates deployed to the relay and Movo production Worker. They do not constitute real email-delivery evidence.

## Exact local commands and evidence

Commands were run from the checkout shown above, with the repository's installed dependencies. The final focused/full checks exited `0` on 2026-08-14:

```sh
npm test
npm run typecheck
npm run build
npm run test:workers
```

Observed results:

- focused send/MIME/DB tests: 3 files passed, 145 tests passed.
- `npm test`: 17 test files passed, 290 tests passed.
- `npm run typecheck`: `tsc -p tsconfig.json --noEmit` passed.
- `npm run build`: Vite production build passed and produced `dist/` assets.
- `npm run test:workers`: 1 worker test file passed, 2 tests passed. The installed Workers runtime warned that the requested `2026-01-15` compatibility date is newer than its supported `2024-12-30` date and fell back to `2024-12-30`; this is recorded, not treated as production-runtime proof.

The deployed upstream relay also passed 15 test files / 121 tests, its production build, and `wrangler deploy --dry-run`.

Required final check:

```sh
git diff --check
```

This check is run after this manifest is added. No lint command is defined in `package.json`; lint is therefore unresolved rather than inferred from the passing checks above.

## Verification matrix

The matrix records local and deployed evidence. No real email send or delivery is claimed.

| Area | Cases required for release | Local evidence / status |
|---|---|---|
| Attachment boundary | 0, 1, and 10 attachments; 11th rejected atomically; zero-byte, malformed Base64, character-size and serialized-message limits | Local tests passed. Authenticated production UI showed `新增附件（0/10）`, accepted 10 fixtures as `10/10`, and rejected the 11th with `最多可附加 10 個檔案。`; relay MIME-size guard is deployed. |
| Recipient boundary | multiple To/Cc/Bcc, invalid address, combined recipient limit, no silent dropping | `test/send.test.ts`, `web/src/lib/api.test.ts`; local tests passed. Relay recipient-array contract is deployed. |
| Bcc privacy | Bcc stays dedicated; absent from visible headers, `.eml`, send log, audit/error/UI surfaces; owner/shared/unrelated access boundaries | Local tests passed. Authenticated production Reply All kept Bcc empty and showed the manual-confirmation guard; no Bcc was auto-exposed. |
| Idempotency | same key and same canonical payload replays one result; same key with changed payload fails closed; concurrent/reconciliation paths do not resend | `test/send.test.ts`, `test/db.test.ts`; local tests passed. Durable Movo claim and relay idempotency contract are deployed; no live send probe was authorized. |
| Threading | Reply and Reply All preserve thread id, `In-Reply-To`, `References`, subject/history; malformed or unauthorized thread fails before relay | `test/send.test.ts`, `test/reply-all.test.ts`, `web/src/lib/compose-reply-all.test.ts`; local tests passed. Relay header mapping is deployed. |
| Reply | sender-only recipient set; no unexpected visible recipients | `test/reply-all.test.ts`, `web/src/lib/compose-reply-all.test.ts`; local tests passed. |
| Reply All | explicit action; sender + visible To/Cc + trusted Bcc; self-removal and case-insensitive deduplication; Bcc remains hidden | Local tests passed. Authenticated production Reply All populated the sender recipient and rendered the original-Bcc provenance confirmation guard. |
| Reply All Bcc provenance | unavailable Bcc blocks automatic Reply All; exact confirmation plus manual Bcc is required | `test/reply-all.test.ts`, `web/src/lib/compose-reply-all.test.ts`, `web/src/components/Compose.test.tsx`; local tests passed. |
| Persistence / failure | durable claim before relay; failed relay has no sent-copy success; post-provider archive failure is `sent_unarchived` and never resends | `test/db.test.ts`, `test/send.test.ts`, `test/api-read.test.ts`; local tests passed. Production `send_attempts` migration is applied and verified. |
| Worker/runtime | API and asset integration under the Workers pool | `npm run test:workers`: passed with the compatibility-date fallback warning noted above. |

## Release boundaries and remaining evidence

1. The relay and Movo production Workers are deployed and their worker-level health/API/asset checks pass. The staging and production D1 migration trackers are reconciled through 0005; production `send_attempts` and indexes are present.
2. Authenticated Cloudflare Access browser proof is complete for the protected production UI: mailbox list, compose, 10/10 attachment boundary, 11th-file rejection, Reply All recipient population, and Bcc privacy guard were observed. No real send was submitted.
3. A controlled delivery probe is **not authorized and not performed**. Any future probe requires an approval record naming an allowlisted disposable recipient/domain, exact payload, purpose, delivery evidence, and cleanup proof.

## No-real-send scope

This review made no external email delivery request and claims no delivery, provider acceptance, sent message, or customer-facing send. The local test suite uses mocks/fixtures and the Workers test pool; it is not a real relay or mailbox delivery test. Keep `CF_EMAIL_API_KEY`, Cloudflare Access credentials, and any other runtime secrets out of evidence, logs, commits, and this manifest.

## Handoff disposition

The requested feature is deployed and verified in production with worker/curl and authenticated browser evidence. Delivery remains intentionally untested because no real send was authorized.
