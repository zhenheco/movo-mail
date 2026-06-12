# Plan 03 — 收信歸屬 + 公海 + 回覆即認領

> Issue: `.scratch/shared-mailboxes/issues/03-inbound-routing-and-claim.md`
> Spec: `docs/superpowers/specs/2026-06-12-shared-mailboxes-design.md` (Slice 3)
> **Blocked by**: Issue 01 (`threads.assignee_id`, `mailboxes.kind` exist) + Issue 02 (`getSendableMailboxes`, send sets `assignee=sender` on new outbound shared threads).
> **TDD mandatory** — every behavior gets a failing test first, then minimal code, then refactor.

---

## 1. Context

Inbound storage routing is unchanged: mail is routed to a mailbox by recipient address and stored under that mailbox's threads. On top of that, this slice adds **ownership routing via `threads.assignee_id`**:

- **Brand-new inbound, no matching thread** (no `In-Reply-To`/`References` hit) → a thread is created. For a **shared** mailbox the new thread is **unclaimed/public**: `assignee_id = NULL`. For a **personal** mailbox the value is also `NULL` (assignee is ignored for personal — owner sees everything regardless), so the same default is correct for both kinds. Inbound never *computes* an assignee.
- **Inbound reply that matches an existing thread** (via `findThreadIdForReply`) → the thread's existing `assignee_id` is **left untouched** ("誰寄的回誰"). `upsertThread`'s UPDATE branch must NOT write `assignee_id`.

**Reply-to-claim** is a **SEND-path** behavior, NOT inbound:

- When a logged-in user **replies into a thread** (`POST /send` with a `threadId`) and that thread belongs to a **shared** mailbox and its `assignee_id IS NULL`, the send atomically **claims** the thread to the replier: `claimThread(env, threadId, userId)`.
- Atomicity = a single conditional UPDATE — **first-write-wins**:
  `UPDATE threads SET assignee_id = ? WHERE id = ? AND assignee_id IS NULL`.
- The claim only applies to **shared** mailboxes; personal threads ignore `assignee`, so `claimThread` is only called when the thread's mailbox `kind = 'shared'`.
- **Concurrency**: two users replying to the same unclaimed shared thread → exactly one UPDATE matches `assignee_id IS NULL` and wins; the loser's `claimThread` returns `false`. **Both replies still send** — losing the claim never blocks the loser's outbound mail; the thread simply belongs to the winner.

> **Coordination with Issue 02** (critical for the implementer): Issue 02 already touches `src/api/send.ts` to (a) use `getSendableMailboxes` for the from-mailbox check and (b) set `assignee = sender` when sending a **new** shared-mailbox thread. Issue 03 wires the **reply** case into that **same** send handler: after `deriveThreading` resolves the existing thread, if `thread.mailbox.kind === 'shared'` and `thread.assignee_id IS NULL`, call `claimThread`. **Claim lives in send.ts, never in inbound.ts.** Inbound.ts only ensures new threads start `assignee_id = NULL`.

---

## 2. Files to touch

| Path | Change (one line) |
|---|---|
| `migrations/0004_shared_mailboxes.sql` | (from Issue 01 — must exist) adds `mailboxes.kind` + `threads.assignee_id`; this slice depends on both columns. |
| `src/db/index.ts` | Add `claimThread(env, threadId, userId)` (conditional UPDATE, returns won/lost). Ensure `upsertThread` sets `assignee_id` only on INSERT (new thread), never on the UPDATE branch; allow an optional `assignee` on `UpsertThreadInput` defaulting to `NULL`. Extend `Thread` reads to select `assignee_id`. |
| `src/api/send.ts` | After threading is derived for a reply: if the replied thread's mailbox `kind='shared'` and `assignee_id IS NULL`, call `claimThread(env, thread.id, dbUserId)`; loser still sends. Resolve `dbUserId` via `getUserByEmail(env, user.email).id` (NOT `user.sub`). |
| `src/email/inbound.ts` | No logic change expected — relies on `insertInboundMessage`/`upsertThread` defaulting new-thread `assignee_id = NULL`. (Touch only if a comment needs updating to state the unclaimed default.) |
| `src/types.ts` | Add `kind: MailboxKind` to `Mailbox`; add `assignee_id: string \| null` to `Thread`. (May already land in Issue 01 — reuse if so.) |

> **Identity note (load-bearing)**: `AccessUser.sub` is the Access token subject, **not** `users.id`. `threads.assignee_id` FKs `users.id`. So the claim's `userId` MUST be the DB user id resolved from `user.email` (`getUserByEmail`), the same identity link `getMailboxesForUser`/`getSendableMailboxes` use — never `user.sub`.

---

## 3. Acceptance criteria (copied from issue 03)

- [ ] 全新客人寄共用地址（無對應 thread）→ 新 thread `assignee_id = NULL`
- [ ] 回信命中既有 thread → `assignee` 不變
- [ ] 回覆未認領共用對話 → 原子認領，`assignee` 變成回覆者
- [ ] 並發認領 first-write-wins（測試模擬兩請求，只有一個寫入成功）
- [ ] 個人信箱收信行為無回歸
- [ ] 測試涵蓋上述行為

---

## 4. Test plan

Good tests assert externally observable behavior (the stored `assignee_id`, the boolean claim outcome, the send still succeeding) — never internal SQL wording.

**Prior-art test paths (cite + mirror their style):**
- `test/db.test.ts` — real-SQL via `node:sqlite` loading the actual migration(s); `makeEnv()`, `seedMailbox`/`seedUser`, `makeInbound()`, `insertInboundMessage` + `getThreads` assertions. **This is the harness for the inbound-assignee and `claimThread` DB tests.** NOTE: it currently loads only `migrations/0001_init.sql` — extend `migrationSql()` to also apply `0004_shared_mailboxes.sql` (and quote `references` consistently) so `assignee_id`/`kind` columns exist.
- `test/send.test.ts` — mocks `../src/db`, mounts `sendRoutes()` on a Hono app with an injected `user`. **This is the harness for the "reply triggers claimThread / loser still sends" send-path tests.** Add `claimThread` + `getUserByEmail` to the db mock.
- `test/inbound.test.ts` — mocks `../src/db`; asserts `insertInboundMessage` call shape. Used only to confirm inbound still does NOT compute/pass an assignee (regression guard).

### 4a. DB-layer tests — `test/db.test.ts`

1. **New inbound to a shared mailbox → `assignee_id = NULL`.** Seed a `kind='shared'` mailbox; `insertInboundMessage(makeInbound(...))`; read the created thread; assert `assignee_id === null`.
2. **New inbound to a personal mailbox → `assignee_id = NULL` (no regression).** Same as above with `kind='personal'`; assert `assignee_id === null` and existing thread fields (subject/unread/message_count) unchanged — guards "個人信箱收信行為無回歸".
3. **Inbound reply matching an existing thread → assignee unchanged.** Seed shared mailbox; manually set the existing thread's `assignee_id` to a seeded user; `insertInboundMessage` a reply (`inReplyTo`/`references` matching the root); assert the thread's `assignee_id` is still that user (unchanged) and `message_count` incremented.
4. **`claimThread` claims an unclaimed thread.** Seed shared thread with `assignee_id = NULL` + a user; `claimThread(env, threadId, userId)` → returns `true`; re-read thread → `assignee_id === userId`.
5. **`claimThread` is a no-op + returns `false` when already claimed.** Seed thread `assignee_id = userA`; `claimThread(env, threadId, userB)` → returns `false`; thread still `assignee_id === userA`.
6. **Concurrent claim is first-write-wins.** Seed unclaimed shared thread + two users. Fire `claimThread(userA)` and `claimThread(userB)` (e.g. `Promise.all`) against the same `threadId`; assert exactly **one** returns `true`, the other `false`, and the stored `assignee_id` equals the winner's id. (See risk note on D1/node:sqlite concurrency below — the conditional `WHERE assignee_id IS NULL` is what guarantees first-write-wins regardless of interleaving; the test asserts the *outcome invariant*, not wall-clock ordering.)
7. **`upsertThread` UPDATE branch never overwrites `assignee_id`.** Create a thread, set `assignee_id`, call `upsertThread` again with the same `threadId` (the inbound-reply path); assert `assignee_id` survives. (Pins the AC-2 mechanism at the DB layer.)

### 4b. Send-path tests — `test/send.test.ts`

8. **Reply into an unclaimed shared thread triggers a claim for the sender.** Mock `getThread` to return a shared-mailbox thread with `assignee_id = null`; mock `getUserByEmail` → `{ id: 'usr_db_id', ... }`; `getSendableMailboxes` includes the shared mailbox; POST `/send` with that `threadId`. Assert `claimThread` was called with `(env, thread.id, 'usr_db_id')` and the response is 2xx (send succeeded).
9. **Reply into an already-claimed shared thread does NOT re-claim wastefully but still sends.** `assignee_id` already set: per design we still *call* `claimThread` (cheap conditional no-op returning false) OR short-circuit — pick one and assert it; the load-bearing assertion is the response is 2xx. (Implementer decides call-vs-guard; test asserts no double-ownership and a successful send.)
10. **Reply into a personal thread never claims.** `getThread` returns a `kind='personal'` thread; POST `/send`; assert `claimThread` was NOT called and send is 2xx.
11. **Loser of a concurrent claim still sends.** Mock `claimThread` to resolve `false`; POST a reply `/send`; assert the response is still 2xx (`ok: true`) — proves "落敗者的回信仍正常寄出". The thread-belongs-to-winner invariant is covered by DB test #6.
12. **Claim failure (DB throw) does not break the send.** Mock `claimThread` to reject; assert send still returns 2xx (claim is best-effort like audit/idempotency persistence in the existing handler).

### 4c. Inbound regression guard — `test/inbound.test.ts`

13. **Inbound never computes an assignee.** Existing tests assert the `insertInboundMessage` call shape; add/confirm that `handleInbound` does not pass any assignee and the unknown-mailbox/threading behaviors are unchanged.

---

## 5. TDD steps (red → green → refactor)

Write each test, watch it fail for the right reason, then write the minimal code to pass, then refactor.

**Pre-req (Issue 01/02 landed):** confirm `migrations/0004_shared_mailboxes.sql` exists and `db.test.ts`'s `migrationSql()` applies it. If `0004` not yet applied in the test harness, that is the very first red→green (test reading `assignee_id` errors on missing column → wire `0004` into `migrationSql()`).

1. **RED — DB new-thread default.** Write test #1 (shared new inbound → `assignee_id = NULL`) and #2 (personal). Run `npm test` → fails (column missing or undefined).
   **GREEN** — extend `db.test.ts` `migrationSql()` to load `0004`; add `assignee_id` to `Thread` reads (`getThreads`/`getThread`/`getThreadsForOwner` SELECT lists) and have `upsertThread` INSERT `assignee_id` (default `NULL`). Tests pass.
2. **RED — assignee unchanged on reply.** Write tests #3 and #7. Run → #7 fails if the UPDATE branch touches `assignee_id` (it currently doesn't select/write it, so confirm it *stays* untouched as columns are added).
   **GREEN** — ensure `upsertThread`'s UPDATE branch leaves `assignee_id` alone; only the INSERT path sets it. Tests pass.
3. **RED — `claimThread` happy path + no-op.** Write tests #4 and #5 calling a not-yet-existing `claimThread`. Run → fails (undefined export).
   **GREEN** — implement `claimThread(env, threadId, userId)` as the single conditional UPDATE returning `(meta.changes ?? 0) > 0`. Tests pass.
4. **RED — concurrency invariant.** Write test #6 (`Promise.all` of two claims). Run → must show exactly-one-winner; if a naive read-then-write impl were used it could double-win.
   **GREEN** — the conditional `WHERE assignee_id IS NULL` already guarantees this; assert the invariant. (No read-modify-write anywhere.)
5. **RED — send path claim wiring.** Add `claimThread` + `getUserByEmail` to the `db` mock in `send.test.ts`; write tests #8, #10, #11, #12 (and #9). Run → fails (send.ts doesn't call `claimThread`).
   **GREEN** — in `src/api/send.ts`, after threading is resolved for a reply: resolve `dbUserId = (await getUserByEmail(env, user.email))?.id`; if `thread` exists, its mailbox `kind === 'shared'`, and `thread.assignee_id == null`, and `dbUserId` is present → `await claimThread(env, thread.id, dbUserId)` wrapped so a throw/false never blocks the send. Tests pass.
6. **RED — inbound regression.** Confirm/extend `inbound.test.ts` #13. Run.
   **GREEN** — no inbound change needed (default flows through `insertInboundMessage`).
7. **REFACTOR** — dedupe the "is this a shared, unclaimed thread?" check; tidy comments to state the unclaimed-default + claim-in-send-path invariants; ensure no opportunistic edits. Re-run full `npm test`.

> Run both pools: `npm test` (node pool — db/send/inbound tests live here) and, if any workers-pool test is added for the email() path, `npm run test:workers` (requires `web/dist`; build first).

---

## 6. Expected test coverage

- **DB (`claimThread`, `upsertThread`, inbound assignee default):** new-thread `assignee_id = NULL` (shared + personal); inbound reply leaves `assignee_id` unchanged; `claimThread` win/no-op/concurrent-first-write-wins; `upsertThread` UPDATE never overwrites assignee. → tests #1–#7.
- **Send path (`POST /send` reply-to-claim):** reply into unclaimed shared → `claimThread(sender)`; already-claimed → no double-ownership; personal → never claims; loser still sends; claim error never breaks send. → tests #8–#12.
- **Inbound regression:** inbound computes no assignee; existing routing/threading unchanged. → test #13 + existing `inbound.test.ts` suite green.
- **Acceptance mapping:** AC1→#1; AC2→#3,#7; AC3→#4,#8; AC4→#6,#11; AC5 (個人無回歸)→#2,#10; AC6 (測試涵蓋)→all above.
- **Not covered here (other slices):** visibility filtering of claimed/unclaimed threads in lists (Slice 4 / Issue 04); new-outbound-thread `assignee=sender` (Issue 02).
