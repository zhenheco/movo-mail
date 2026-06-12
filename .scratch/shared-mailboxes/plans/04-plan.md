# Plan 04 — 可見性（個人/共用/admin）+ 統一收件匣 (Visibility + Unified Inbox) (TDD)

> Issue: `.scratch/shared-mailboxes/issues/04-visibility-and-unified-inbox.md`
> PRD: `.scratch/shared-mailboxes/PRD.md` · Spec: `docs/superpowers/specs/2026-06-12-shared-mailboxes-design.md` (Slice 4)
> 做法 A（`mailboxes.kind` + `threads.assignee_id`），非權限表。
> **Blocked by**: Issue 01 (`mailboxes.kind`, `threads.assignee_id` columns; `Mailbox.kind`/`Thread.assignee_id` types), Issue 02 (`getSendableMailboxes`; send sets `assignee=sender` on new shared threads; thread SELECTs already carry `assignee_id`), Issue 03 (`claimThread`; reply-to-claim wired in send).
> **TDD mandatory** — every behavior gets a failing test FIRST, then minimal code, then refactor. No test-after.

---

## 1. Context

This slice closes the read half of shared mailboxes: every list **and** single-resource read must filter threads by mailbox **kind** + thread **assignee** + the caller's **admin role**. The write/claim machinery (01–03) already stamps `threads.assignee_id`; nothing here computes ownership — this slice only *reads* it correctly.

**Visibility predicate** (the single rule every read path must encode), for a thread `t` in mailbox `mb`, viewer `U` (DB user id `U.id`, resolved via `getUserByEmail(env, U.email)`), admin flag `isAdmin`:

| mailbox kind | non-admin sees | admin sees |
|---|---|---|
| `personal` | `mb.owner_id = U.id` (owner-only; **unchanged**) | **same — owner-only** (admin gets NO extra access to others' personal mailboxes) |
| `shared` | `t.assignee_id = U.id OR t.assignee_id IS NULL` | **ALL** shared threads (incl. others' claimed) |

**Unified inbox** (`GET /api/threads/all`) = personal(owned, all threads) ∪ shared(assignee=me OR NULL); **admin additionally** = ∪ shared(all, incl. others' claimed). The query must compose these branches in ONE SQL statement (no JS post-filter — see Risks §7) so another user's threads are never materialized into the Worker, mirroring the existing `getThreadsForOwner`/`searchMessagesForOwner` "scope-in-SQL-before-LIMIT" discipline.

**Single-thread / single-message reads** (`GET /message/:id`, plus the thread load inside `POST /ai/draft`) currently gate on `userOwnsMailbox` (personal-owner-only). That helper now wrongly denies *every* shared-mailbox read (shared mailboxes have `owner_id = NULL`, so they're never in the owned set) — and, symmetrically, must NOT over-fetch (a non-admin must not read another user's *claimed* shared thread, nor anyone's personal thread). So single-read gating moves to the SAME predicate as the list (IDOR / over-fetch closed at the resource level, not just the list level).

**Hard boundaries to encode explicitly:**
- `personal` mailbox threads stay **strictly owner-only even for admin** (PRD User Story #10, Out-of-Scope: "Admin 讀取個人信箱內容").
- `getMailboxesForUser` contract is **unchanged** — it stays personal-only (login gate + `/mailboxes` picker must not be polluted by shared mailboxes). Issue 02's `getSendableMailboxes` is the send-set; this slice adds a separate read-visibility query and does NOT touch `getMailboxesForUser`.

---

## 2. Files to touch

| Path | Change (one line) |
|---|---|
| `src/db/index.ts` | **Add** `getVisibleThreadsForUser(env, { userId, isAdmin })` (unified-inbox visibility query, single SQL composing personal-owned ∪ shared(mine+unclaimed) [∪ shared-all if admin]); **add** `getThreadsVisible(env, mailboxId, { userId, isAdmin })` for the per-mailbox shared list; **add** `canUserReadThread(env, threadId, { userId, isAdmin })` (single-thread predicate, returns bool) used by single-resource reads. Reuse the `assignee_id`/`kind` columns added in 01/02. **Do NOT touch `getMailboxesForUser` / `getThreadsForOwner` contracts** (leave `getThreadsForOwner` in place or delete only if no longer referenced — confirm via grep). |
| `src/api/scope.ts` | **Add** `resolveViewer(env, user): Promise<{ userId: string \| null; isAdmin: boolean }>` — resolves DB `users.id` via `getUserByEmail(env, user.email)` (NOT `user.sub`) + admin flag via `getUserRole(env, user.email)`. **Add** `canViewThread(env, user, thread)` / `canViewMailboxThreads` thin wrappers if cleaner. Keep `getOwnedMailboxIds`/`userOwnsMailbox` for any personal-only callers, but the read routes switch to the new visibility helpers. |
| `src/api/threads.ts` | `/threads/all` → call `getVisibleThreadsForUser` with the resolved viewer (replaces `getThreadsForOwner`). `/threads?mailbox=` → for a `personal` mailbox keep `userOwnsMailbox` gate then `getThreads`; for a `shared` mailbox gate on "is a shared mailbox" (any logged-in user may list it) then `getThreadsVisible` (assignee=me OR NULL, or all-if-admin). Resolve mailbox kind first. |
| `src/api/message.ts` | `GET /message/:id` → replace the `userOwnsMailbox(message.mailbox_id)` gate with the visibility predicate: resolve the message's thread, apply `canUserReadThread`; deny as **404** (existing convention — never leak existence). |
| `src/api/ai.ts` | `POST /ai/draft` → the `userOwnsMailbox(thread.mailbox_id)` gate (`src/api/ai.ts:146`) becomes the same `canUserReadThread` visibility check (a non-owner replying via AI to a shared thread they can see is allowed; a personal-mailbox thread they don't own, or another user's claimed shared thread, is denied). |
| `src/types.ts` | (No new type expected — `Mailbox.kind` + `Thread.assignee_id` land in 01/02. Add a small `Viewer = { userId: string \| null; isAdmin: boolean }` helper type only if it improves the scope.ts signatures.) |
| `test/db.test.ts` | **Modify.** Extend `migrationSql()` to also apply `0002_user_role.sql` (for `users.role`) **and** `0004_shared_mailboxes.sql` (for `kind`/`assignee_id`) in order — currently loads only `0001`. Add visibility DB tests (§4a). |
| `test/api-read.test.ts` | **Modify.** Add `getVisibleThreadsForUser` / `getThreadsVisible` / `canUserReadThread` / `getUserByEmail` / `getUserRole` to the `vi.mock("../src/db")` surface; add route-layer visibility + IDOR tests (§4b). |
| `test/ai.test.ts` | **Modify (regression + over-fetch guard).** Update the db mock + add a case: AI draft on a shared thread the caller can see → allowed; on a personal thread they don't own / another's claimed shared thread → 403/404. |

> Naming: the spec's Modules table names `getVisibleThreadFilter` / `getOwnedMailboxIds` for `src/api/scope.ts`. This plan keeps the *behavior* (a visibility filter) but pushes the actual filtering INTO SQL (db layer) for the security reason in §7, exposing `resolveViewer` from scope.ts + `getVisibleThreadsForUser`/`getThreadsVisible`/`canUserReadThread` from the db layer. If the executor prefers the spec's exact name, `getVisibleThreadFilter` may wrap `resolveViewer` — but the filter must be applied in SQL, not as a JS `.filter()` over a global fetch.

---

## 3. Acceptance criteria (copied from issue 04)

- [ ] 共用信箱列表：使用者只見 `assignee = me OR NULL`
- [ ] Priss 看不到 Kee 已認領的共用對話（反之亦然）
- [ ] 未認領共用對話 Kee、Priss 都看得到
- [ ] 統一收件匣含個人信箱全部 + 共用信箱（我的 + 未認領）
- [ ] admin 看得到共用信箱所有對話（含他人已認領）
- [ ] admin 看不到別人的個人信箱內容
- [ ] 越權讀取單一 thread/訊息被擋（403/404）
- [ ] 個人信箱可見性無回歸
- [ ] 測試涵蓋上述行為

---

## 4. Test plan

Good tests assert externally observable behavior (which thread ids a viewer gets back; the read endpoint's status code) — never internal SQL wording.

**Prior-art test paths (cite + mirror style):**
- `test/db.test.ts` — real-SQL via `node:sqlite` loading the actual migration(s); `makeEnv()`, `seedMailbox`/`seedUser`, `makeInbound()`, `insertInboundMessage` + `getThreads`/`getThreadsForOwner` assertions. **Canonical harness for the visibility DB tests.** NOTE (from task brief): `migrationSql()` currently loads only `0001_init.sql` — extend it to apply `0002_user_role.sql` (role column) + `0004_shared_mailboxes.sql` (kind/assignee_id), reusing the existing `references`-quote shim. (See the cleaner `loadMigration(name)` + ordered-apply pattern in `test/db-admin.test.ts:103-120` for reference; `seedUser` there inserts a user whose role can be promoted via `UPDATE users SET role='admin'` — mirror that to seed an admin.)
- `test/api-read.test.ts` — db contract fully mocked; mounts the real read router behind a stub that injects a fixed `user`; asserts *route* status + scoping (already has the 403/404 IDOR cases for `/threads` and `/message/:id` — extend the same `dispatch()` harness). **Canonical harness for route-layer visibility + IDOR.**
- `test/db-admin.test.ts` — prior art for seeding users + promoting role to `admin` in the real-SQL harness.
- `test/ai.test.ts` — prior art for the AI-draft route gate (mirror its db mock to add the visibility helper + assert the over-fetch deny).

### 4a. DB-layer tests — `test/db.test.ts` (real SQL)

Seed fixture (reused across cases): users `kee` (`u-kee`/`kee@gmail.com`), `priss` (`u-priss`), `boss` (`u-boss`, promoted to `role='admin'`); personal mailboxes `kee@movo`(owner `u-kee`), `priss@movo`(owner `u-priss`); shared mailbox `hello@movo`(`kind='shared'`, `owner_id NULL`). Threads: `T_kee_personal`(in `kee@`), `T_priss_personal`(in `priss@`), `T_unclaimed`(shared, `assignee_id NULL`), `T_kee_claimed`(shared, `assignee_id=u-kee`), `T_priss_claimed`(shared, `assignee_id=u-priss`).

1. **Shared list shows assignee=me OR NULL.** `getThreadsVisible(env, hello@.id, { userId: u-kee, isAdmin:false })` → returns `{T_unclaimed, T_kee_claimed}`, excludes `T_priss_claimed`. (AC1)
2. **Priss can't see Kee's claimed shared thread (and vice-versa).** Same query for `u-priss` → `{T_unclaimed, T_priss_claimed}`, excludes `T_kee_claimed`. (AC2)
3. **Unclaimed shared thread visible to both.** `T_unclaimed.id` appears in both #1 and #2 result sets. (AC3)
4. **Unified inbox = personal-all ∪ shared(mine + unclaimed).** `getVisibleThreadsForUser(env, { userId: u-kee, isAdmin:false })` → `{T_kee_personal, T_unclaimed, T_kee_claimed}`; **excludes** `T_priss_personal` (other's personal) and `T_priss_claimed` (other's claimed shared). Assert newest-activity-first ordering + each row carries a real `last_message_id` (mirrors existing `getThreadsForOwner` assertions). (AC4)
5. **Admin sees ALL shared threads incl. others' claimed.** `getVisibleThreadsForUser(env, { userId: u-boss, isAdmin:true })` → shared set includes `{T_unclaimed, T_kee_claimed, T_priss_claimed}` (all three), regardless of `boss`'s assignee. (AC5)
6. **Admin CANNOT see others' personal mailbox content.** Same admin query → **excludes** `T_kee_personal` and `T_priss_personal` (boss owns neither). Personal stays owner-only even for admin. (AC6 — the explicit boundary)
7. **Admin owning a personal mailbox still sees their own personal + all shared (no self-lockout).** Give `boss` a personal mailbox `boss@`+thread; assert it appears, proving the personal branch is `owner_id = U.id` not "non-admin only".
8. **Personal-mailbox visibility no regression.** `getThreadsVisible(env, kee@.id, { userId:u-kee, isAdmin:false })` returns all of `kee@`'s threads exactly as `getThreads` did (assignee is ignored for personal — owner sees everything); a non-owner non-admin gets nothing. (AC8)
9. **`canUserReadThread` predicate matches the list predicate.** Parameterized over the fixture: `canUserReadThread(kee, T_unclaimed)`→true, `(kee, T_kee_claimed)`→true, `(kee, T_priss_claimed)`→false, `(kee, T_priss_personal)`→false, `(boss-admin, T_priss_claimed)`→true, `(boss-admin, T_kee_personal)`→**false** (admin still blocked from personal), `(kee, T_kee_personal)`→true. (AC7 single-read parity)
10. **Injection-safe.** `getVisibleThreadsForUser(env, { userId: "ghost' OR '1'='1", isAdmin:false })` → `[]` (no rows); mirrors existing `getThreadsForOwner` injection test.

### 4b. Route-layer tests — `test/api-read.test.ts` (mocked db)

Add to the `vi.mock("../src/db")` surface: `getVisibleThreadsForUser`, `getThreadsVisible`, `canUserReadThread`, `getUserByEmail`, `getUserRole`. In `beforeEach`, default `getUserByEmail → { id:'u-kee', email:USER.email, role:'user', … }` and `getUserRole → 'user'` (non-admin viewer).

11. **`GET /threads/all` uses the visibility query, scoped by resolved viewer.** Mock `getVisibleThreadsForUser` → `[th-a, th-b]`; assert 200, body ids match, and it was called with the resolved `{ userId:'u-kee', isAdmin:false }` (NOT `user.sub`, NOT `getThreadsForOwner`). (AC4 wiring)
12. **`GET /threads/all` for an admin passes `isAdmin:true`.** `getUserRole → 'admin'`; assert `getVisibleThreadsForUser` called with `isAdmin:true`. (AC5 wiring)
13. **`GET /threads?mailbox=<shared>` lists for a non-owner.** Mock the mailbox lookup → `kind:'shared'`; assert `getThreadsVisible` called (not a 403), 200. (AC1 wiring — shared mailbox is listable by any logged-in user, unlike personal.)
14. **`GET /threads?mailbox=<other-personal>` → 403.** mailbox `kind:'personal'`, not owned → 403, no thread query called. (AC8 regression — personal stays owner-only.)
15. **`GET /message/:id` blocked when caller can't read the thread → 404.** `getMessage` returns a message on a thread `canUserReadThread → false`; assert 404 (existence not leaked), message body NOT returned. (AC7 IDOR)
16. **`GET /message/:id` allowed when `canUserReadThread → true`.** Returns 200 + the message. Covers the *unblock* direction: a shared-mailbox message the viewer can see is now reachable (the old `userOwnsMailbox` gate would have wrongly 404'd it).
17. **`GET /message/:id` for another user's CLAIMED shared message → 404.** `canUserReadThread → false`; 404. (AC2 + AC7 at resource level — over-fetch closed.)

### 4c. AI-route over-fetch guard — `test/ai.test.ts`

18. **AI draft on a visible shared thread → allowed.** `canUserReadThread → true`; existing happy path still 200.
19. **AI draft on a thread the caller can't read → 403/404.** `canUserReadThread → false` (other's claimed shared, or unowned personal); assert the existing deny status (match whatever `ai.ts` returns today for the `userOwnsMailbox=false` case — keep the same code) and no draft generated.

---

## 5. TDD steps (red → green → refactor)

Write each test, watch it fail for the RIGHT reason, then minimal code, then refactor.

### Step 0 — Prereq (Issues 01/02/03 landed)
Confirm `migrations/0004_shared_mailboxes.sql` exists and `Mailbox.kind` / `Thread.assignee_id` are typed + selected by thread reads (landed in 01/02). Extend `test/db.test.ts` `migrationSql()` to apply `0002_user_role.sql` + `0004_shared_mailboxes.sql` after `0001` (ordered), reusing the `references`-quote shim. If this isn't done first, the visibility tests fail on "no such column: kind/assignee_id/role" instead of on behavior. Add a `seedClaimedThread` / `promoteToAdmin` helper in the test mirroring `db-admin.test.ts`.

### Step 1 — RED: DB unified-inbox visibility
1. Add tests 4a.1–4a.10 referencing not-yet-existing `getThreadsVisible`, `getVisibleThreadsForUser`, `canUserReadThread`. Run `npm test -- db` → red ("not a function" / behavior wrong).

### Step 2 — GREEN: DB visibility queries (single SQL each)
2. In `src/db/index.ts` add `getVisibleThreadsForUser(env, { userId, isAdmin })`: one `SELECT … FROM threads t JOIN mailboxes mb ON mb.id = t.mailbox_id` with a WHERE that composes the branches as parameterized predicates:
   ```
   WHERE
     (mb.kind = 'personal' AND mb.owner_id = ?1)               -- own personal (all)
     OR (mb.kind = 'shared' AND (?2 = 1                         -- admin → all shared
                                 OR t.assignee_id = ?1          -- my claimed
                                 OR t.assignee_id IS NULL))     -- unclaimed (公海)
   ORDER BY t.last_message_at DESC
   ```
   (bind `userId` as `?1`, `isAdmin?1:0` as `?2`). Personal branch deliberately has **no admin clause** — admin gains nothing on personal. Mirror `getThreadsForOwner`'s `last_message_id` correlated subquery + `{ ...r }` fresh-object mapping + `guard(...)`. A null `userId` (unknown user) still binds safely and returns the public/own subset correctly (personal branch can't match a null owner_id; shared unclaimed still shows — acceptable, but the routes resolve a real id first).
3. Add `getThreadsVisible(env, mailboxId, { userId, isAdmin })`: `getThreads`-shaped query plus `WHERE t.mailbox_id = ?` AND the kind/assignee predicate (so a personal mailbox returns all rows for its owner, a shared mailbox returns assignee=me OR NULL, or all-if-admin). Reuse the same predicate fragment.
4. Add `canUserReadThread(env, threadId, { userId, isAdmin })`: `SELECT 1 FROM threads t JOIN mailboxes mb … WHERE t.id = ? AND (<same predicate>)`; return `(row !== null)`. Run `npm test -- db` → 4a green.

### Step 3 — RED: scope.ts viewer resolution
5. Add a small scope test (or extend an existing scope/auth test) asserting `resolveViewer(env, user)` returns `{ userId: <db users.id from getUserByEmail>, isAdmin: role==='admin' }` and NEVER `user.sub`. Run → red.

### Step 4 — GREEN: scope.ts
6. In `src/api/scope.ts` add `resolveViewer(env, user)`: `const dbUser = await getUserByEmail(env, user.email); const role = await getUserRole(env, user.email); return { userId: dbUser?.id ?? null, isAdmin: role === 'admin' };`. (Load-bearing: `assignee_id` FKs `users.id`, so the compare MUST use `dbUser.id`, not `user.sub` — see Risks.) Run → green.

### Step 5 — RED: route wiring (threads/all, threads, message, ai)
7. Add db-mock entries + tests 4b.11–4b.17 to `test/api-read.test.ts` and 4c.18–4c.19 to `test/ai.test.ts`. Run → red (routes still call `getThreadsForOwner` / `userOwnsMailbox`).

### Step 6 — GREEN: route handlers
8. `src/api/threads.ts` `/threads/all`: `const viewer = await resolveViewer(c.env, user); const threads = await getVisibleThreadsForUser(c.env, viewer);`. `/threads?mailbox=`: resolve mailbox (need its `kind` — add a light `getMailboxById` or reuse an existing lookup; if none exists, the per-mailbox handler can branch on whether `userOwnsMailbox` is true → personal path, else check the mailbox is `kind='shared'` before `getThreadsVisible`). Keep the personal `userOwnsMailbox`→403 behavior intact.
9. `src/api/message.ts`: after `getMessage`, `const viewer = await resolveViewer(...); if (!message || !(await canUserReadThread(c.env, message.thread_id, viewer))) return 404;`. (Resolve via `message.thread_id` — the message row carries it.)
10. `src/api/ai.ts:146`: swap `userOwnsMailbox(c.env, user, thread.mailbox_id)` for `canUserReadThread(c.env, thread.id, await resolveViewer(c.env, user))`; keep the existing deny status code. Run full `npm test` → green.

### Step 7 — REFACTOR
11. Extract the shared WHERE predicate fragment (a `VISIBLE_THREAD_PREDICATE` SQL const + bind helper) so `getVisibleThreadsForUser` / `getThreadsVisible` / `canUserReadThread` can't drift apart (a drift = a silent IDOR). Cache `resolveViewer` per request if it's called twice in one handler. Decide whether `getThreadsForOwner` is now dead (grep `src/`, `test/`) — if unreferenced, delete it + its tests OR mark `@deprecated` (Hard Rule 12); if `searchMessagesForOwner` still uses the owner-only model, flag that unified *search* visibility is out-of-scope here (issue 04 is thread lists; note it for a follow-up). No opportunistic reformatting (Hard Rule 8). Re-run `npm test` + `npm run typecheck`.

> Run the node pool (`npm test` — db/api-read/ai tests live here). If any workers-pool read test is added, `npm run test:workers` (needs `web/dist`; build first).

---

## 6. Expected test coverage

- **DB visibility (`getVisibleThreadsForUser`, `getThreadsVisible`, `canUserReadThread`):** shared list = assignee me OR NULL; Priss ≠ Kee's claimed; unclaimed seen by both; unified = personal-all ∪ shared(mine+unclaimed); admin = all shared incl. others' claimed; admin excluded from others' personal; admin-self personal still visible; personal no-regression; predicate parity for single-read; injection-safe. → 4a.1–4a.10.
- **scope.ts (`resolveViewer`):** resolves DB `users.id` (not `user.sub`) + admin flag. → Step 3 test.
- **Route wiring (`/threads/all`, `/threads`, `/message/:id`, `/ai/draft`):** unified uses the visibility query with the resolved viewer; admin passes `isAdmin:true`; shared mailbox listable by non-owner; other's personal mailbox → 403; single-message IDOR → 404 (incl. other's claimed shared); visible shared message now reachable (un-block direction); AI over-fetch denied. → 4b.11–4b.17, 4c.18–4c.19.
- **Acceptance mapping:** AC1→4a.1,4b.13; AC2→4a.2,4b.17; AC3→4a.3; AC4→4a.4,4b.11; AC5→4a.5,4b.12; AC6→4a.6; AC7(越權 single-read)→4a.9,4b.15-17,4c.19; AC8(個人無回歸)→4a.8,4b.14; AC9(測試涵蓋)→all.
- **Not covered here (other slices / out-of-scope):** frontend shared badges + unclaimed-state UI (Slice 5 / Issue 05); unified *search* visibility across shared mailboxes (this slice is thread lists + single-read; flag as follow-up if `searchMessagesForOwner` still owner-only); claim/send mechanics (01–03).

---

## 7. Risks / notes (for the executor)

- **IDOR surface — single-thread/message reads (highest risk).** The existing read gate is `userOwnsMailbox(mailbox_id)` (personal-owner-only). For shared mailboxes (`owner_id = NULL`) it (a) wrongly **denies** every legitimate shared read, and (b) if naïvely loosened to "any shared mailbox", would wrongly **expose** another user's *claimed* shared thread. Both directions must be fixed by the SAME `canUserReadThread` predicate as the list — gate at the **thread/assignee** level, not the mailbox level. `GET /message/:id` (`src/api/message.ts:38`) and the AI-draft thread load (`src/api/ai.ts:146`) are the two IDOR entry points; both must switch. Deny stays **404** for `/message` (existing no-leak convention), the AI route keeps its current deny code. Any future single-resource read added later must reuse `canUserReadThread` — the refactor extracting one shared SQL predicate (Step 7) is what prevents drift.
- **Unified-inbox query composition (second risk).** Personal, shared-mine+unclaimed, and admin-all-shared MUST compose in ONE parameterized SQL `WHERE` (the §5.2 shape), filtered **before any LIMIT**, never as a global fetch + JS `.filter()`. A JS filter materializes other users' rows into the Worker (memory + a latent leak if a later code path forgets to filter) and breaks ordering/pagination — exactly the anti-pattern the existing `searchMessagesForOwner` comment (`src/db/index.ts:346-351`) warns against. The personal branch carries **no admin clause** so admin can never widen into others' personal mailboxes; the shared branch's `?2 = 1` (isAdmin) is the only admin widening, and only for `kind='shared'`. Encode the personal-owner-only-even-for-admin boundary as its own test (4a.6) so a future "admin sees all" refactor can't silently swallow personal privacy.
- **Identity — compare against `users.id`, NOT `user.sub` (load-bearing).** `threads.assignee_id` FKs `users.id` (minted by `upsertUserByEmail`); `AccessUser.sub` is the Access token subject, a different value in this World-B model. The visibility predicate compares `t.assignee_id = ?userId` and `mb.owner_id = ?userId` where `userId` MUST be `getUserByEmail(env, user.email).id` (the same link `getMailboxesForUser`/`getSendableMailboxes`/Issue 03's `claimThread` use). `resolveViewer` is the single place this resolves; if it ever passed `user.sub`, every viewer would match zero claimed threads and zero owned personal mailboxes (silent under-fetch) — assert it explicitly (Step 3).
- **`getMailboxesForUser` must stay personal-only.** Do NOT route visibility through it or pollute it — the login gate (`src/middleware/access.ts:139`) and `/mailboxes` picker (`src/api/mailboxes.ts`) depend on it returning only owned personal mailboxes (Issue 02 Risk lock). This slice adds *new* read-visibility queries; it does not change that contract.
- **`getThreadsForOwner` dead-code decision.** `/threads/all` stops calling it. Grep before deleting (`src/`, `test/db.test.ts` has direct unit tests for it). Either delete fn + tests, or `@deprecated` it (Hard Rule 12). Don't leave two ways to list the unified inbox — that's a future IDOR (one filtered, one not).
- **Test harness migration order.** `test/db.test.ts` `migrationSql()` loads only `0001`. Visibility tests need `users.role` (`0002`) AND `kind`/`assignee_id` (`0004`). Extend it to apply `0001→0002→0004` in order with the `references`-quote shim (the cleaner `loadMigration()` ordered pattern is in `test/db-admin.test.ts:103-120`). Without this, red tests fail on "no such column" not behavior.
- **Per-mailbox `/threads?mailbox=` needs the mailbox kind.** The handler must know if the requested mailbox is personal (owner-gate→`getThreads`) or shared (shared-gate→`getThreadsVisible`). If no `getMailboxById` exists, add a thin one or fold the kind lookup into `getThreadsVisible` (which already joins mailboxes) — but the 403 for a non-owned **personal** mailbox must be preserved (AC8 / test 4b.14).
