# Plan 02 — 共用信箱寄信 + 寄件歸屬 (Shared send + ownership)

> Issue: `.scratch/shared-mailboxes/issues/02-shared-send-and-ownership.md`
> PRD: `.scratch/shared-mailboxes/PRD.md` · Spec: `docs/superpowers/specs/2026-06-12-shared-mailboxes-design.md`
> **Blocked by Issue 01** (migration `0004` adds `mailboxes.kind` + `threads.assignee_id`). This plan ASSUMES those columns exist.

---

## 1. Context

This slice delivers the send half of shared mailboxes (Vertical Slice 2):

- **Any logged-in user can send from a shared mailbox.** Send validation switches from "owned mailboxes only" to a new **sendable set** = the user's owned personal mailboxes ∪ ALL shared mailboxes.
- **A new outbound thread from a shared mailbox is claimed by its sender:** when a send from a `kind='shared'` mailbox creates a brand-new thread (not a reply to an existing thread), that thread's `assignee_id` is set to the sender's user id. The customer's reply then routes only to the sender (visibility enforced in Slice 4 / Issue 04).
- **Personal mailboxes stay owner-only to send.** A non-owner selecting someone else's personal mailbox gets `403` — unchanged behaviour.
- **`from` stays server-forced** to `mailbox.address`; a client-supplied `from` is never trusted (existing behaviour, kept).

Out of scope here (belongs to later slices/issues, do not implement):
- Reply-to-claim of an *existing* unclaimed shared thread (Issue 03). This plan must **not clobber** an existing thread's `assignee_id` on reply.
- Inbound `assignee` initial value (Issue 03).
- Visibility filtering of thread lists (Issue 04).

---

## 2. Files to touch

| Path | Change (one line) |
|---|---|
| `src/types.ts` | Add `kind: MailboxKind` to `Mailbox` (and `MailboxKind = "personal" \| "shared"`); add `assignee_id` to `Thread` (load-time alignment with migration 0004). |
| `src/db/index.ts` | Add `getSendableMailboxes(env, user)` (owned personal ∪ all shared); include `kind` column in mailbox SELECTs; add `assignee_id` to thread SELECTs; teach `insertOutboundMessage` / `upsertThread` to set `assignee_id` only when minting a NEW shared thread. **Do NOT touch `getMailboxesForUser`.** |
| `src/api/send.ts` | Resolve the caller's mailbox from `getSendableMailboxes` instead of `getMailboxesForUser`; on a brand-new (non-reply) send from a `kind='shared'` mailbox, pass `assigneeId = user id` to persistence. `from` forcing + rate-limit + idempotency unchanged. |
| `test/send.test.ts` | Add shared-send route tests (mock `getSendableMailboxes`); update existing mock surface. |
| `test/db.test.ts` | Add `getSendableMailboxes` + shared-thread `assignee_id` persistence tests (real node:sqlite). Requires migration `0004` to be loaded by the test harness (see Risk). |

> Note: `src/api/scope.ts` (`getOwnedMailboxIds`) is **NOT** changed in this slice — it stays bound to `getMailboxesForUser` for personal read scope. Visibility changes are Issue 04.

---

## 3. Acceptance criteria (copied from issue)

- [ ] 任一登入 user 可指定共用信箱為寄件地址並成功寄出
- [ ] 寄件 `from` 被 server 強制為信箱地址（偽造的 client `from` 無效）
- [ ] 非擁有者嘗試從別人的個人信箱寄信 → 403
- [ ] 從共用信箱開新對話 → 該 thread `assignee_id` = 寄信者
- [ ] 登入放行邏輯（擁有 ≥1 信箱才放行）不因共用信箱存在而改變
- [ ] 測試涵蓋上述行為（共用可寄、個人 403、from 強制、新對話 assignee=sender）

---

## 4. Test plan

Tests are NOT co-located; they live under `/test/`. **Prior art: `test/send.test.ts`** (route tests mocking the `../src/db` module) and **`test/db.test.ts`** (db-layer tests running real parameterized SQL via `node:sqlite` against the loaded migration). Mirror both styles.

### 4a. Route behaviours — `test/send.test.ts` (mock db)

The existing file mocks `getMailboxesForUser`. Add `getSendableMailboxes` to the `vi.mock("../src/db", …)` surface and to `beforeEach` resets. Add a shared fixture, e.g. `SHARED_MAILBOX = { id: "mbx_hello", address: "hello@movo.com.my", display_name: "Hello", owner_id: null, kind: "shared", … }` and mark the existing `MAILBOX` fixture `kind: "personal"`.

External behaviours to assert (one `it` each):

1. **Shared send works for a non-owner** — `getSendableMailboxes` returns `[SHARED_MAILBOX]` (user owns no personal mailbox of that id; `owner_id` is null). POST with `mailboxId: SHARED_MAILBOX.id` → `200`, relay called once, `sentBody().from === "hello@movo.com.my"`.
2. **`from` is server-forced** — POST a spoofed `from: { address: "attacker@evil.com" }` against the shared mailbox → relay `from` is the mailbox address, never `evil.com`. (Mirrors the existing personal-mailbox forcing test at `test/send.test.ts:272`.)
3. **Sending from someone else's personal mailbox → 403** — `getSendableMailboxes` returns `[SHARED_MAILBOX]` only (the other user's personal mailbox is NOT in the set). POST `mailboxId: "mbx_someone_personal"` → `403`, relay NOT called. (Mirrors `test/send.test.ts:293` "rejects a mailboxId the user does not own".)
4. **New shared thread → assignee = sender** — no `threadId` in body, `mailboxId: SHARED_MAILBOX.id` → `200`; assert `insertOutboundMessage` was called with `arg.assigneeId === USER.sub` (the sender's user id) **and** `arg.threadId === undefined` (brand-new thread, mints a real one — mirrors `test/send.test.ts:422`).
5. **New PERSONAL thread → no assignee set** — no `threadId`, `mailboxId: MAILBOX.id` (personal) → `200`; assert `insertOutboundMessage` called with `arg.assigneeId == null` (personal mailboxes ignore assignee).
6. **Reply on a shared thread does NOT carry an assignee from the send path** — `getThread` returns a thread on `SHARED_MAILBOX`, POST with that `threadId` → `200`; assert the send path passes `assigneeId == null` (it must NOT claim on reply; claim logic is Issue 03). Reuses the threading-reply fixture pattern at `test/send.test.ts:350`.

> Regression guard: the existing suite (from-forcing, sole-mailbox, multi-mailbox-requires-id, rate-limit, idempotency, suppression 4xx, 502) must still pass with `getMailboxesForUser` swapped to `getSendableMailboxes` in the route. Keep those tests green.

### 4b. Data layer — `test/db.test.ts` (real SQL)

1. **`getSendableMailboxes` = owned personal ∪ ALL shared** — seed: user U owns personal `kee@` (kind=personal); user V owns personal `priss@`; two shared `hello@`/`service@` (kind=shared, owner_id NULL). Assert `getSendableMailboxes(env, U)` returns exactly `{kee@, hello@, service@}` — includes both shared, includes U's personal, excludes V's personal.
2. **`getMailboxesForUser` is NOT polluted** — same seed; assert `getMailboxesForUser(env, U.email)` returns ONLY `{kee@}` (no shared). This is the hard-requirement regression lock.
3. **New shared thread persists `assignee_id` = sender** — call `insertOutboundMessage` with a shared `mailboxId`, no `threadId`, and `assigneeId = U.id`; read back the minted thread and assert `assignee_id === U.id`.
4. **Reply (existing threadId) does NOT change `assignee_id`** — seed a shared thread with `assignee_id = V.id`; call `insertOutboundMessage` with that `threadId` and `assigneeId = U.id`; assert the thread's `assignee_id` is still `V.id` (no clobber).
5. **Personal new thread ignores assignee** — `insertOutboundMessage` to a personal mailbox with `assigneeId` omitted → minted thread `assignee_id` is NULL.

---

## 5. TDD steps (red → green → refactor)

**Hard rule: write the failing test FIRST, confirm it fails for the right reason, then minimal implementation, then refactor. No test-after.**

### Step 0 — Prereq (Issue 01)
Confirm migration `0004` exists and the db test harness loads it (see Risk §7). If the harness only loads `0001_init.sql`, extend `migrationSql()` in `test/db.test.ts` to also apply `0004` (and the `references`-quote shim style if needed) BEFORE writing the assignee tests — otherwise red tests fail on "no such column" instead of on the behaviour under test.

### Step 1 — RED: db `getSendableMailboxes` + non-pollution
1. Add tests 4b.1 and 4b.2 to `test/db.test.ts`. Import `getSendableMailboxes` (does not exist yet) → compile/red.
2. Run `npm test -- db` → confirm failure is "getSendableMailboxes is not a function" (4b.1) and that 4b.2 passes already (proves the lock) OR fails (proves it's needed). Keep 4b.2 regardless as a permanent guard.

### Step 2 — GREEN: implement `getSendableMailboxes`
3. In `src/db/index.ts` add:
   ```
   getSendableMailboxes(env, user): Promise<Mailbox[]>
     = SELECT … FROM mailboxes m
        LEFT JOIN users u ON u.id = m.owner_id
       WHERE m.kind = 'shared'
          OR (m.kind = 'personal' AND u.email = ?)   -- bound, normalized
       ORDER BY m.address ASC
   ```
   Use `normalizeEmail(user.email)`; wrap in `guard("getSendableMailboxes", …)`; return fresh objects (`{ ...r }`). Add `kind` to the SELECT column list here and in `getMailboxesForUser`/`getMailboxByAddress` (so the `Mailbox.kind` type is populated).
4. Add `kind` to `Mailbox` and `MailboxKind` union in `src/types.ts`.
5. Run `npm test -- db` → 4b.1 + 4b.2 green. **Do NOT edit `getMailboxesForUser`'s WHERE/JOIN** — only its column list to add `kind`.

### Step 3 — RED: db assignee persistence on new shared thread
6. Add tests 4b.3, 4b.4, 4b.5. They reference an `assigneeId` field on `OutboundMessageInput` and an `assignee_id` column. Run → red ("no such column" if Step 0 not done; otherwise assignee not persisted).

### Step 4 — GREEN: persist assignee only when minting a new shared thread
7. Add optional `assigneeId?: string | null` to `OutboundMessageInput` and an optional `assigneeId` to `UpsertThreadInput`.
8. In `upsertThread`: on the INSERT (new thread) branch, write `assignee_id` from `input.assigneeId ?? null`. On the UPDATE (existing thread) branch, **do NOT touch `assignee_id`** (no clobber — Issue 03 owns claim). Add `assignee_id` to the INSERT column list.
9. `insertOutboundMessage` forwards `msg.assigneeId` into the `upsertThread` call.
10. Add `assignee_id` to thread SELECTs (`getThread`, `getThreads`, `getThreadsForOwner`) and the `Thread` type so reads expose it.
11. Run `npm test -- db` → 4b.3–4b.5 green.

### Step 5 — RED: route shared-send behaviours
12. Update `test/send.test.ts`: add `getSendableMailboxes` to the `vi.mock` surface + `beforeEach` (`getSendableMailboxes.mockResolvedValue([MAILBOX])` to keep legacy tests green), add `kind` to fixtures, add `SHARED_MAILBOX`. Add tests 4a.1–4a.6. Run → red (route still calls `getMailboxesForUser`; `assigneeId` not passed).

### Step 6 — GREEN: route uses sendable set + sets assignee on new shared thread
13. In `src/api/send.ts`:
    - Replace the `getMailboxesForUser` import/call with `getSendableMailboxes(c.env, user)`. Keep the `owned.length === 0 → 403` guard, the `mailboxId` resolution, the sole-mailbox shortcut, and the multi-mailbox-requires-id branch verbatim (rename the local `owned` → `sendable` for clarity only if it stays traceable).
    - Compute `assigneeId`: `const isNewThread = thread === null;` (after `deriveThreading`). `const assigneeId = isNewThread && mailbox.kind === "shared" ? user.sub : null;`
    - Pass `assigneeId` into the `insertOutboundMessage(c.env, { …, ...(assigneeId ? { assigneeId } : {}) })` call (only on the brand-new branch where `threadId` is omitted; reply branch passes nothing → no clobber).
14. Run `npm test -- send` → all green. Run full `npm test` → no regressions.

### Step 7 — REFACTOR
15. De-duplicate the mailbox SELECT column list if it now repeats `kind` across functions (extract a `MAILBOX_COLS` const like the existing `MESSAGE_COLS`). Keep every diff line traceable; no opportunistic beautification. Re-run full suite.

---

## 6. Expected test coverage

- `src/db/getSendableMailboxes`: owned-personal-∪-all-shared composition; excludes other users' personal; `getMailboxesForUser` non-pollution lock.
- `src/db` assignee persistence: new shared thread sets `assignee_id`; reply does NOT clobber; personal new thread leaves NULL.
- `src/api/send` route: shared send works for non-owner; `from` server-forced on shared; non-owner personal → 403; new shared thread → `assigneeId = sender`; new personal thread → no assignee; reply path passes no assignee.
- Regression: the full existing `test/send.test.ts` suite (12 route + 4 transport cases) stays green after the `getMailboxesForUser → getSendableMailboxes` swap.

---

## 7. Risks / notes (for the executor)

- **HARD REQUIREMENT — do not pollute the login gate.** `getMailboxesForUser` (used by `accessAuth` login gate at `src/middleware/access.ts:139` and by personal read scope at `src/api/scope.ts:23`) MUST keep returning ONLY owned personal mailboxes. Shared mailboxes flow through the NEW `getSendableMailboxes` only. Test 4b.2 is the permanent lock; never relax it. If `getMailboxesForUser` started returning shared mailboxes, every login would pass even for users who own nothing (because shared mailboxes exist), and personal read scope would leak shared threads through the wrong path.
- **`getSendableMailboxes` ↔ existing send.ts validation.** The route's existing `mailboxId` validation (`owned.find(m => m.id === mailboxId)` → 403 if not found; sole-mailbox shortcut; multi-mailbox-requires-id) is reused verbatim against the sendable set — no new branch needed. One behavioural shift to flag: a user who owns one personal mailbox but for whom ≥1 shared mailbox exists now has `sendable.length > 1`, so the "sole owned mailbox, omit mailboxId" shortcut (`test/send.test.ts:334`) will require an explicit `mailboxId`. That is correct (ambiguous which mailbox to send from) but is a UX/behaviour change — the frontend Compose picker (Slice 5) must always send `mailboxId`. Note it in the executor handoff; the route returns a clean 400, not a wrong-mailbox send.
- **Migration load in db tests.** `test/db.test.ts` builds its in-memory SQLite from `migrations/0001_init.sql` only (`migrationSql()` at ~line 119). The new assignee/kind columns come from `0004` (Issue 01). Step 0 must extend `migrationSql()` to also load `0004` (applying the same `references`-quoting shim convention if `0004` references reserved words) or the assignee tests fail on "no such column" rather than on behaviour. Confirm Issue 01 landed `migrations/0004_shared_mailboxes.sql` first.
- **Sender id source.** The thread `assignee_id` must be a `users.id`, not the email. `user.sub` is the Access subject id; verify it equals `users.id` in this World-B identity model. If `users.id` is a separate uuid (it is — minted by `upsertUserByEmail`), the route must resolve the user id via the user's email rather than trusting `user.sub`. **Flag for the executor:** confirm whether `accessAuth` populates `user.sub` with the D1 `users.id`; if not, resolve `assigneeId` from `getUserByEmail(env, user.email)` before persisting, and the FK `threads.assignee_id → users(id)` will enforce correctness (a bad id → insert error). This is the single load-bearing correctness check for AC #4.
