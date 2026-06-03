# Movo Mail — Pre-onboarding UAT report (2026-06-03)

**Original verdict: NOT ready.** **Fix status (2026-06-03, post-Codex + Gemini cross-review): B2/H1/B3/H3/H2 fixed in the working tree, all gates green; B1 + H2-secret are operator actions; then deploy + manual UAT.**

## Fix status

| # | Fix | State |
|---|---|---|
| B2 | web send false-failure + double-send | ✅ fixed (`web/src/lib/api.ts`, `Compose.tsx`, types) |
| H1 | send 403 → ownership + mailboxId | ✅ fixed (`src/api/send.ts`) |
| B3 | AdminPanel "Owner login email" relabel | ✅ fixed (`AdminPanel.tsx`) |
| H3 | email normalize (write+read) | ✅ fixed (`src/db/index.ts`) |
| H2 | inbound setReject when FALLBACK_FORWARD unset | ✅ fixed (`src/index.ts`) |
| B1 | first-admin seed | ⏳ operator runs `wrangler d1` (below) |
| H2-secret | verify/set FALLBACK_FORWARD | ⏳ operator runs `wrangler secret` |

Gates after fix: typecheck ✅ · unit 157 ✅ · workers 2 ✅ · web 23 ✅ · build ✅.

### Gemini cross-review adjudication (3 red, 2 yellow → 0 actionable)
- 🔴 #1/#2 "normalizeEmail vs case-sensitive users.email (`TEXT UNIQUE`, no COLLATE NOCASE) → miss/duplicate legacy MixedCase rows" → **CONDITIONAL, closed for fresh deploy.** App now writes+reads lowercase consistently; the only risk is pre-existing mixed-case rows. Pre-onboarding the `users` table is empty/seed-only. **Guard:** before onboarding, confirm `SELECT email FROM users WHERE email <> lower(email)` returns 0 rows (folded into B1 below). Optional future hardening: a `0004` migration adding `COLLATE NOCASE` to `users.email` (table-rebuild; not warranted on an empty table).
- 🔴 #3 "createAdminMailbox return shape changed → breaks callers" → **REFUTED.** No caller consumes the return (`AdminPanel.tsx:90-96` discards it); the OLD return was `undefined` (server sends flat `{id}`, never `{mailbox}`). New `{id}` is strictly correct; 23 web tests + build pass.
- 🟡 #4 "scope idempotency key to user" → **REFUTED.** Already mailbox-scoped (`send_idem:${mailbox.id}:${key}`) and the mailbox is owner-validated → no cross-user collision.
- 🟡 #5 "`owned[0]!` non-null assertion smell" → cosmetic, length-guarded; left as-is (no opportunistic edit).

---

**Original verdict: NOT ready to onboard real mailboxes as-is.** Automated gates are all green, but
3 blockers + several high/medium issues will break the onboarding flow. Most are masked by
tests that encode the wrong contract.

## Automated gates (all run locally)

| Gate | Result |
|---|---|
| `tsc --noEmit` | ✅ ok |
| `vitest run` (unit) | ✅ 152 pass / 0 fail |
| `vitest run --config vitest.workers.config.ts` | ✅ 2 pass / 0 fail |
| `vite build` | ✅ 196 KB / gzip 64 KB |

Green ≠ correct: the send contract, the admin bootstrap, and the inbound forward config are
exactly the spots the suite does not exercise (or exercises against a fictional server shape).

---

## BLOCKERS (must fix before onboarding)

### B1 — No first-admin seed → operator cannot even open Settings (chicken-and-egg)
- **Evidence:** `src/api/admin.ts:55-65` guard requires `getUserRole === 'admin'`;
  `src/db/index.ts:467-493` `upsertUserByEmail` always inserts `role='user'` (role excluded from UPDATE);
  `migrations/0002_user_role.sql:6` `DEFAULT 'user'`. Zero seed / role-grant anywhere outside tests.
  The ONLY code path that inserts a `users` row is `createMailbox` — which is itself admin-gated.
- **Impact:** On the fresh production DB nobody has `role='admin'`, so `GET /api/me` returns
  `isAdmin:false`, the Settings entry never renders, and `POST /admin/mailboxes` 403s. You cannot
  create the first mailbox. **This stops "用 admin 開信箱給他們" before it starts.**
- **Fix (one-time bootstrap, manual):** insert/promote your Access login email to admin:
  ```sql
  -- run against movo-mail-production D1; <ADMIN_LOGIN_EMAIL> = the email you sign into CF Access with, lowercased
  INSERT INTO users (id, email, name, role, created_at, updated_at)
  VALUES (lower(hex(randomblob(16))), '<ADMIN_LOGIN_EMAIL>', NULL, 'admin', unixepoch()*1000, unixepoch()*1000)
  ON CONFLICT(email) DO UPDATE SET role='admin';
  ```
  `npx wrangler d1 execute movo-mail-production --remote --command "<SQL>"`. Then document it in README.

### B2 — Send UI reports "Failed to send" on every successful send + retry double-sends (CONFIRMED, auth-independent)
- **Evidence:** server `POST /send` returns FLAT `{ok,id,status,messageId}` (`src/api/send.ts:475`, replay `:297`);
  `web/src/lib/api.ts:211` `sendMessage` reads `data.result` → `undefined`;
  `web/src/components/Compose.tsx:102` `onSent(result.id)` → TypeError → caught → `setSendError("Failed to send")`.
  The mail WAS sent. No `Idempotency-Key` is sent by the client (`api.ts:211`), and the server only dedupes
  when one is present (`send.ts:293-299`) → user's natural retry = duplicate real send.
- **Test blind spot:** `api.test.ts` only tests `sendMessage`'s network-error path; the success envelope is untested.
  `createAdminMailbox` is even tested against a `{mailbox}` shape the server never returns (`admin.ts:109` → `{id}`).
- **Fix (web/src/lib/api.ts):** return the flat object directly and attach a per-send idempotency key:
  ```ts
  export async function sendMessage(body: SendRequest, idemKey: string): Promise<SendResult> {
    return await request<SendResult>(`/send`, {
      method: "POST",
      headers: { "Idempotency-Key": idemKey },
      body: JSON.stringify(body),
    });
  }
  ```
  Generate `idemKey` ONCE per logical send in `Compose.handleSend` (so a retry reuses the same key).
  `Compose.tsx:102` already reads `result.id` correctly once the flat object is returned.
  Optionally delete the phantom `SendResponse {result}` type and add a success-shape test.

### B3 — `ownerEmail` must be the Access LOGIN identity, NOT the @movo address — AdminPanel placeholder is misleading
- **Evidence:** `src/middleware/access.ts:122-146` authorizes via `getMailboxesForUser(jwt.email)`;
  `src/db/index.ts:342-359` JOINs `users.email = jwt.email`. The owner is bound by whatever `ownerEmail`
  the admin typed. `AdminPanel.tsx:129-137` placeholder is `owner@movo.com.my`, and `admin.ts:40,102`
  EMAIL regex accepts ANY domain — so a wrong value passes validation silently.
- **Impact:** if a user signs into CF Access with their personal Google/Gmail but the admin typed the
  `@movo.com.my` address into ownerEmail, the JWT email ≠ stored email → `getMailboxesForUser` = `[]` →
  403 "No mailbox is provisioned" empty state. Provisioned but owns nothing.
- **Whether this is a blocker depends on the onboarding identity model — see "Decision" below.**

---

## HIGH

### H1 — Send 403 for owner-model logins (`send.ts` resolves sender by ADDRESS, not ownership)
- **Evidence:** `src/api/send.ts:271` `getMailboxByAddress(c.env, user.email)` looks up a mailbox whose
  **address == login email**, but `50c7c17` switched auth/read to **ownership** (`owner_id`).
  `test/send.test.ts:48-61` masks it: `USER.email == MAILBOX.address`; `:189` mocks the lookup to return
  the mailbox for any arg.
- **Impact:** in the "login = Gmail ≠ @movo address" model, `getMailboxByAddress(gmail)` = null → **403 on every send**,
  even though the user passed the ownership auth gate and can read their inbox. Also: a multi-mailbox owner
  can never choose which mailbox to send from (send.ts ignores any client `mailboxId`).
- **Fix:** resolve sender by ownership + an SPA-supplied `mailboxId` validated against the owned set
  (mirror the read routes): use `getMailboxesForUser`, pick by `mailboxId` (or the sole owned mailbox),
  keep `from` forced to `mailbox.address`. Update the masking tests.

### H2 — `FALLBACK_FORWARD` not in repo config → non-managed inbound mail may be silently dropped
- **Evidence:** required `Env.FALLBACK_FORWARD` (`src/types.ts:44`) used by `src/index.ts:81`
  `message.forward(env.FALLBACK_FORWARD)`; **0 matches in `wrangler.toml`** (all 3 sections) and not in the
  documented secrets list or `deploy.yml`. If unset at runtime, `forward(undefined)` rejects → caught at
  `index.ts:82` → swallowed → mail lost. (Classification failure also routes to this path, `index.ts:71`.)
- **Verify (only way to confirm):** `npx wrangler secret list --env production` (and staging/default).
  If absent: `printf '%s' '<verified-dest@addr>' | npx wrangler secret put FALLBACK_FORWARD --env production`.
- **Harden:** in `email()`, if `!env.FALLBACK_FORWARD` → `message.setReject('temporary configuration error')`
  (retryable SMTP error) instead of catch-and-swallow, so mail is never silently lost.

### H3 — `ownerEmail` stored verbatim while addresses are normalized → casing mismatch 403
- **Evidence:** `src/db/index.ts:835-836` passes `input.ownerEmail` RAW to `upsertUserByEmail`
  (no `normalizeAddress`), while the mailbox address is lowercased at `:829`. JWT emails are generally
  lowercased; `access.ts:136`/`getUserRole` bind the raw email with exact-match (no `LOWER()`).
- **Impact:** any uppercase in ownerEmail → login binds lowercase → mismatch → 403, and an intended admin
  silently loses admin. Case-variant duplicate `users` rows can also coexist.
- **Fix:** lowercase-normalize ownerEmail on write AND the JWT email on every read lookup, identically.

---

## MEDIUM / operational caveats

- **M1 — CF Email Routing precedence shadows the catch-all** (`src/index.ts:56`): if an address has an
  explicit higher-priority forward rule, mail never reaches the worker → a managed mailbox for it stores
  nothing. Before creating a managed mailbox for an address that currently has its own routing rule,
  remove that rule. (priss@/kee@ are noted as such forwards.)
- **M2 — global search LIMIT before owned-filter** (`src/db/index.ts:299`): an unscoped search does a global
  `LIMIT 100` then filters to owned, so a user's own matches can be pushed out by other mailboxes' rows.
  In practice the SPA always passes the active `mailboxId` (scoped in SQL), so low real impact.
- XSS: `html_body` is sanitized client-side with DOMPurify (`MessageBody.tsx`, the `ca40ffc` decision).
  No XSS finding was raised; confirm the DOMPurify allow-list in the manual pass (no `javascript:` URLs,
  `target=_blank` gets `rel=noopener`).

---

## What IS solid (verified safe)

- Admin authorization guard: non-admin cannot reach any `/admin/*` handler; no privilege-escalation/role-mutation
  endpoint exists; `getUserRole` failure → 500 (fails closed). (`admin.ts:55-68`, `test/api-admin.test.ts`)
- Mailbox address validation `@movo.com.my` only; case-variant duplicate mailboxes impossible
  (`0003` UNIQUE + `normalizeAddress`); 409 on duplicate with UNIQUE-race catch.
- Read scoping: `/threads`, `/message/:id`, `/search`, `/ai/draft` all gate on ownership; cross-mailbox
  data does not leak (404, not 403, to avoid existence leaks).
- Open-thread → latest message (`last_message_id` subquery) — the `c9e5396`/`ca40ffc` fixes hold.
- Parameterized SQL throughout; CASCADE delete; immutable returns; comprehensive error handling.

---

## Manual browser UAT checklist (Access-gated → operator runs this)

Prereq: B1 admin seed done; B2/H1 fixes deployed; H2 secret verified.

1. Sign into CF Access as the admin identity → inbox loads (not the "contact your administrator" empty state).
2. Settings (gear) is visible → open it → "Add a mailbox" with a real address + the owner's **Access login email**.
3. Send a test email FROM outside TO the new address → within ~1 min it appears in that mailbox's inbox.
4. Open the thread → latest message renders (no 404/500); HTML body renders sanitized.
5. Reply → click Send → UI shows "Message sent" (NOT "Failed to send"); the sent copy appears in the thread.
6. Send a brand-new message (not a reply) → success; appears as its own thread.
7. Sign in as the OWNER identity (their Google login) → they land in their inbox and can read + send.
8. Confirm a non-admin owner does NOT see Settings and `GET /api/admin/mailboxes` 403s for them.
9. Send a message to a NON-managed @movo.com.my address → confirm it forwards to the fallback (H2), not dropped.
