# Plan 01 — Schema + 信箱分型 + 供裝 (TDD)

> Issue: `.scratch/shared-mailboxes/issues/01-schema-mailbox-kind-provisioning.md`
> PRD: `.scratch/shared-mailboxes/PRD.md`
> Spec: `docs/superpowers/specs/2026-06-12-shared-mailboxes-design.md`
> 做法 A（`mailboxes.kind` + `threads.assignee_id`），非權限表。

---

## 1. Context

This slice lays the shared-mailbox data foundation: a new migration `0004` adds
`mailboxes.kind` (`'personal'` default | `'shared'`) and `threads.assignee_id`
(nullable FK to `users.id`, `ON DELETE SET NULL`). `POST /admin/mailboxes` gains
an optional `kind`; when `kind='shared'` the `ownerEmail` may be empty/absent
(unowned shared mailbox), while `kind='personal'` (or omitted) keeps today's
behavior and still requires a valid owner. The `kind` default is `'personal'`,
so every existing mailbox is untouched and there is zero behavioral regression.

This is the only schema/provisioning slice — sending, inbound assignment,
claiming, and visibility filtering (Slices 2–5) are out of scope here. The
`assignee_id` column is added now but is NOT read or written by any code in this
slice; it only ships as schema so later slices can use it without a second
migration.

## 2. Files to touch

| Path | Change |
|---|---|
| `migrations/0004_shared_mailboxes.sql` | **New.** Two `ALTER TABLE` statements adding `mailboxes.kind` and `threads.assignee_id` (exact SQL in §5). |
| `src/types.ts` | Add `kind: MailboxKind` to `Mailbox`; add `kind: MailboxKind` to `AdminMailbox`; add `assignee_id: string \| null` to `Thread`; add a `MailboxKind = 'personal' \| 'shared'` union. |
| `src/db/index.ts` | `CreateMailboxInput` gains `kind: MailboxKind`; `createMailbox` writes the `kind` column; `getMailboxByAddress` / `getMailboxesForUser` / `listAllMailboxes` SELECT `kind` so reads carry it. |
| `src/api/admin.ts` | Parse optional `kind` from the body (default `'personal'`); when `kind='shared'`, allow empty/absent `ownerEmail` (pass `null`); when `kind='personal'` (or omitted), keep the existing "valid owner required" 400. Address regex (`MOVO_ADDRESS`) unchanged. |
| `test/db-admin.test.ts` | **Modify.** Load `0004` in `makeEnv()`; add `kind` assertions + shared-without-owner cases (prior art for the db layer). |
| `test/api-admin.test.ts` | **Modify.** Add route cases: `kind='shared'` no owner → 201 (forwards `kind:'shared', ownerEmail:null` to `createMailbox`); `kind='personal'` no owner → 400; omitted `kind` → defaults to `'personal'`. |

> Note: spec lists the migration filename as `migrations/0004_shared_mailboxes.sql`.
> The existing convention is `NNNN_snake_case.sql` (`0001_init`, `0002_user_role`,
> `0003_mailboxes_address_unique`), so `0004_shared_mailboxes.sql` matches.

## 3. Acceptance criteria (copied from issue)

- [ ] migration `0004` 套用到 dev/test D1 成功，欄位與預設值正確
- [ ] `POST /admin/mailboxes` 可建立 `kind='shared'` 且不帶 owner 的信箱
- [ ] `kind='personal'`（或省略 kind）仍要求有效 owner，行為與現狀一致
- [ ] 既有個人信箱讀寫/登入/可見性無回歸（kind 預設 personal）
- [ ] 對應測試涵蓋：建 shared（無 owner）成功、建 personal 無 owner→拒絕

## 4. Test plan

Two existing test files are modified (no new test files needed); both already
follow the project's two harness styles.

### `test/db-admin.test.ts` (real-SQL db layer — PRIOR ART)

Prior art used: **`test/db-admin.test.ts`** — exercises the real parameterized
SQL against Node's built-in `node:sqlite` engine, applying every migration in
order in `makeEnv()` (currently `0001` → `0002` → `0003`). This is the canonical
db-layer harness; mirror its style exactly.

External behaviors to assert (db layer):

- `makeEnv()` also applies `0004_shared_mailboxes.sql`; the suite still passes
  (proves the migration is valid SQLite and applies cleanly in order).
- `createMailbox({ kind: 'personal', ownerEmail })` → row stored with
  `kind='personal'` and the owner resolved (verify via a raw
  `SELECT kind FROM mailboxes` and via `getMailboxByAddress` carrying `kind`).
- `createMailbox({ kind: 'shared', ownerEmail: null })` → row stored with
  `kind='shared'` and `owner_id IS NULL`; `listAllMailboxes` lists it with
  `ownerEmail: null` and `kind: 'shared'`.
- Default behavior: a mailbox created via `createMailbox` with `kind:'personal'`
  reads back `kind='personal'` (column default `'personal'` confirmed by a raw
  insert WITHOUT the kind column, asserting the read is `'personal'`).
- Regression guard: existing `createMailbox`/`listAllMailboxes`/`deleteMailbox`
  cases continue to pass unchanged.

### `test/api-admin.test.ts` (route layer with mocked db — PRIOR ART)

Prior art used: **`test/api-admin.test.ts`** — db contract fully mocked; asserts
*route* behavior (validation, status mapping, what gets forwarded to
`createMailbox`). Mirror its `dispatch(ADMIN, …)` harness.

External behaviors to assert (route layer):

- `POST /admin/mailboxes` with `{ address, kind:'shared' }` and NO `ownerEmail`
  → 201; `createMailbox` called with `{ address, ownerEmail: null, displayName,
  kind: 'shared' }`.
- `POST /admin/mailboxes` with `{ address, kind:'shared', ownerEmail:'' }`
  (empty string) → 201, `ownerEmail: null` forwarded.
- `POST /admin/mailboxes` with `{ address }` (no `kind`, no `ownerEmail`) → 400
  (defaults to `'personal'`, owner still required); `createMailbox` NOT called.
- `POST /admin/mailboxes` with `{ address, kind:'personal', ownerEmail:'nope' }`
  → 400 (invalid owner); `createMailbox` NOT called.
- `POST /admin/mailboxes` with `{ address, kind:'shared', ownerEmail:'x@y.com' }`
  → 201; owner IS forwarded (shared mailbox may still optionally have an owner).
- `POST /admin/mailboxes` with `{ address, kind:'bogus', ownerEmail }` → 400
  (unknown kind rejected) OR coerced to `'personal'` — pick reject-with-400 as
  the stricter, fail-loud choice; assert 400 + `createMailbox` not called.
- Regression guard: the existing 201/400/409/500 + welcome-email cases keep
  passing; existing happy-path assertion updated to expect the extra
  `kind: 'personal'` field forwarded to `createMailbox`.

> Both suites run under the default node pool (`vitest run`,
> `vitest.config.ts` → `test/**/*.test.ts`). No `test/workers/**` change needed.

## 5. TDD steps (red → green → refactor)

### RED 1 — db-layer failing tests

1. Edit `test/db-admin.test.ts` `makeEnv()` to also apply the new migration:
   ```ts
   db.exec(loadMigration("0003_mailboxes_address_unique.sql"));
   db.exec(loadMigration("0004_shared_mailboxes.sql")); // NEW
   ```
2. Add the db assertions from §4 (kind stored for personal/shared, default
   `'personal'`, shared+null-owner). Run `npm test` →
   FAILS: `0004_shared_mailboxes.sql` does not exist (ENOENT) and
   `CreateMailboxInput.kind` is not yet a field (type error).

### RED 2 — route-layer failing tests

3. Add the route cases from §4 to `test/api-admin.test.ts`. Run `npm test` →
   FAILS: handler does not parse `kind`, does not allow shared-without-owner,
   and forwards no `kind` to the mocked `createMailbox`.

### GREEN 1 — migration

4. Create `migrations/0004_shared_mailboxes.sql` with EXACTLY:
   ```sql
   -- Movo Mail — shared mailboxes (0004)
   -- 做法 A: a mailbox kind + a per-thread assignee, no permission table.
   --
   -- mailboxes.kind: 'personal' (default — every existing row folds here, zero
   --   regression) | 'shared' (company address any logged-in user may send from).
   -- threads.assignee_id: the user who "owns" a shared-mailbox conversation.
   --   NULL = unclaimed (public/公海) or a personal-mailbox thread (ignored).
   --   ON DELETE SET NULL so deleting a user un-claims their threads, never
   --   cascades away the conversation.
   --
   -- D1 migrations run exactly once; both are single additive ALTERs (no backfill
   -- needed — the column DEFAULT covers existing rows).

   ALTER TABLE mailboxes ADD COLUMN kind TEXT NOT NULL DEFAULT 'personal';
   ALTER TABLE threads ADD COLUMN assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL;
   ```
   Run `npm test` → db-layer migration-applies test now passes; db assertions
   still fail until step 5.

### GREEN 2 — types + db layer

5. `src/types.ts`: add `export type MailboxKind = "personal" | "shared";`; add
   `kind: MailboxKind` to `Mailbox` and to `AdminMailbox`; add
   `assignee_id: string | null` to `Thread`.
6. `src/db/index.ts`:
   - `CreateMailboxInput`: add `kind: MailboxKind;`.
   - `createMailbox`: include `kind` in the INSERT column list + bind
     `input.kind` (keep the existing normalize/duplicate-check/race handling
     untouched; only the INSERT changes):
     ```sql
     INSERT INTO mailboxes
       (id, address, display_name, owner_id, kind, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ```
   - `getMailboxByAddress` + `getMailboxesForUser`: add `kind` to the SELECT
     column list so reads carry it (matches the new `Mailbox` type).
   - `listAllMailboxes`: add `m.kind AS kind` to the SELECT.
   Run `npm test` → db-layer suite passes.

### GREEN 3 — admin route

7. `src/api/admin.ts`:
   - `CreateMailboxBody`: add `kind?: unknown;`.
   - Parse: `const kind = body.kind === "shared" ? "shared" : body.kind === "personal" || body.kind === undefined ? "personal" : null;`
     (an explicit unknown kind → `null` → 400 fail-loud).
   - After the `MOVO_ADDRESS` check, before the owner check:
     ```ts
     if (kind === null) {
       return c.json({ error: "kind must be 'personal' or 'shared'." }, 400);
     }
     ```
   - Owner validation becomes kind-aware:
     - `kind === 'personal'` → keep `if (!EMAIL.test(ownerEmail)) return 400`.
     - `kind === 'shared'` → owner optional: only validate when a non-empty
       `ownerEmail` was supplied; otherwise pass `null`.
   - Build input: `const input: CreateMailboxInput = { address, ownerEmail: ownerEmail || null, displayName, kind };`
     (so empty string → `null`; matches `createMailbox`'s `ownerEmail ? upsert : null`).
   - `MOVO_ADDRESS` and `EMAIL` regexes UNCHANGED.
   - Welcome-email block: keep best-effort, but only attempt when an
     `ownerEmail` exists (no owner = no recipient); guard
     `if (input.ownerEmail) { … sendWelcomeEmail … }` so a shared, ownerless
     mailbox reports `welcomeEmailSent: false` without calling the relay.
   Run `npm test` → route suite passes.

### REFACTOR

8. With all tests green: factor the kind-parse into a small local helper only if
   it reads cleaner (e.g. `parseKind(body.kind)`); keep the diff minimal — no
   unrelated reformatting (Hard Rule 8). Re-run `npm test` + `npm run typecheck`.

## 6. Expected test coverage

- Migration `0004` applies cleanly in-order against real SQLite (`db-admin`
  harness boots `0001→0002→0003→0004`).
- `mailboxes.kind` default `'personal'` proven (raw insert without the column).
- `createMailbox` persists `kind` for both `'personal'` and `'shared'`; reads
  (`getMailboxByAddress`, `getMailboxesForUser`, `listAllMailboxes`) carry it.
- Shared mailbox creatable with `ownerEmail: null` (DB) and via the route with
  absent/empty `ownerEmail` (API) → 201.
- Personal mailbox without a valid owner → 400 (route), unchanged from today.
- Unknown `kind` → 400 (fail-loud).
- Address regex unchanged (existing 400-on-non-`@movo.com.my` cases still pass).
- Regression: all pre-existing `db-admin` + `api-admin` cases pass unmodified
  (except the one happy-path assertion that now also expects `kind:'personal'`).
- NOT covered here (later slices): `assignee_id` reads/writes, claiming,
  visibility filtering, send/inbound — `assignee_id` ships as schema only.

## 7. Migration apply note (dev/test only — NOT prod)

Prod D1 is applied separately by the orchestrator (see PRD §Further Notes).
`wrangler deploy` does NOT auto-apply D1 migrations — apply explicitly:

```sh
# Local dev D1 (default env, binding DB → database "movo-mail")
npx wrangler d1 migrations apply movo-mail --local

# Remote dev D1 (same default-env database, remote)
npx wrangler d1 migrations apply movo-mail --remote

# Staging (the isolated test DB used to verify before prod)
npx wrangler d1 migrations apply movo-mail-staging --env staging --remote
```

> DO NOT run `wrangler d1 migrations apply movo-mail-production …` in this slice
> — production is handled out-of-band by the orchestrator after test-DB verify.
> The automated db-layer tests do NOT use wrangler at all; they load the
> migration files directly via `node:sqlite`, so the `:memory:` DB is the test
> oracle for "the migration is valid + columns/defaults correct".
