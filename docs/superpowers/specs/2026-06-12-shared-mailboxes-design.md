# Movo Mail — 共用信箱（Shared Mailboxes） — SPEC

> 做法 A（`mailboxes.kind` + `threads.assignee_id`），非做法 B（權限表）。
> prd_id = `2026-06-12-shared-mailboxes`。
>
> **Update 2026-06-13**：`Customer@` 與 `Service@` 合併為單一 `customerservice@movo.com.my`
> （display "Customer Service"）。現行共用信箱 = `hello@` + `customerservice@`。
> 下文 `Customer@`／`Service@` 為原始設計記錄，視為同一個 `customerservice@`。
> prod D1 已套用（兩者皆無歷史 thread/訊息，乾淨合併）；舊地址改走 FALLBACK_FORWARD。

---

## Problem Statement

Kee 和 Priss 想用公司公用地址 `Hello@`／`Customer@`／`Service@movo.com.my` 對外往來，
但 Movo Mail 目前每個信箱只有單一擁有者，使用者只能收發「自己擁有的信箱」。痛點：

1. 三個公用地址沒人能在 Movo Mail 裡拿來寄信。
2. 客人寄到公用地址的信沒有共用收件匣，不知道誰該回。
3. Kee／Priss 各自對外的往來會混在一起、或互相看到對方的私人信件。

## Solution

新增「共用信箱」。Kee、Priss 登入後都能在 Compose 寄件選單選 `Hello@`／`Customer@`／
`Service@`（標「共用」）寄信。你從共用地址寄出的對話，客人回信**只進你的收件匣**。
全新客人主動寄到公用地址、還沒人接的信，Kee／Priss **都看得到（公海）**，誰先回覆就**歸誰**，
之後別人看不到後續往返。個人信箱 `Kee@`／`Priss@` 維持私有、行為不變。Admin 能看共用信箱所有對話。

## User Stories

1. As Kee/Priss, I want to pick `Hello@`/`Customer@`/`Service@` as my "from" address in Compose, so that I can reply to customers as the company.
2. As any logged-in user, I want shared addresses visibly marked「共用」in the sender picker and mailbox list, so that I don't confuse them with my personal mailbox.
3. As Kee, when I send a new message from `Service@`, I want the customer's reply to land only in my inbox, so that I keep ownership of conversations I started.
4. As Priss, I want NOT to see Kee's claimed `Service@` conversations, so that personal workload stays separate.
5. As Kee/Priss, when a brand-new customer emails `Hello@` (no prior thread), I want both of us to see it as "unclaimed", so that whoever is free can pick it up.
6. As whoever replies first to an unclaimed shared thread, I want that reply to auto-claim the thread to me, so that subsequent replies route only to me.
7. As a second user replying to the same unclaimed thread concurrently, I want the claim to be first-write-wins, so that ownership is unambiguous (my reply still sends).
8. As any user, I want my unified inbox to show my personal mailboxes (all) plus shared mailboxes (my claimed + unclaimed), so that I have one place to work.
9. As an admin (`nelsonjou1101@gmail.com`), I want to see ALL conversations in shared mailboxes (including others' claimed), so that I can oversee company correspondence.
10. As an admin, I do NOT get access to other users' personal mailbox contents (`Kee@`/`Priss@`), so that personal privacy is preserved.
11. As the system, when sending from any mailbox, the "from" address is server-forced to the mailbox address, so that a client cannot spoof identity.
12. As a non-owner, I cannot send from someone else's personal mailbox (403), so that personal mailboxes stay private to send.
13. As an admin, I want to create a shared mailbox (`kind=shared`, no owner) via the admin panel, so that provisioning `Hello@`/`Customer@`/`Service@` works without an owner Gmail.
14. As an admin, I want to create the two personal mailboxes (`Kee@`→yeekerster@gmail, `Priss@`→moneymanagerpy@gmail) via the existing flow.

## Modules

| Module | 職責（一句） | 公開介面（窄） | 新建/修改 |
|---|---|---|---|
| `migrations/0004_shared_mailboxes.sql` | 加 `mailboxes.kind` + `threads.assignee_id` | SQL DDL | 新建 |
| `src/db/index.ts` | mailbox/thread 讀寫 + 新查詢 | `getSendableMailboxes(env,user)`, `claimThread(env,threadId,userId)`, 可見性過濾查詢 | 修改 |
| `src/api/send.ts` | 寄信權限 + 寄件歸屬 | `POST /send` | 修改 |
| `src/email/inbound.ts` | 收信存檔 + thread assignee 初值 | `handleInbound` | 修改 |
| `src/api/scope.ts` | 讀取可見範圍（個人/共用/admin） | `getVisibleThreadFilter`, `getOwnedMailboxIds` | 修改 |
| `src/api/admin.ts` | 建立信箱支援 `kind=shared`、owner 可空 | `POST /admin/mailboxes` | 修改 |
| `web/src/components/Compose.tsx` | 寄件選單含共用信箱 + 標記 | props `fromOptions` | 修改 |
| web inbox/list UI | 共用信箱標記 + 未認領狀態 | — | 修改 |

## Implementation Decisions

- **Schema**:
  - `mailboxes` ADD `kind TEXT NOT NULL DEFAULT 'personal'`（`'personal'`｜`'shared'`）
  - `threads` ADD `assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL`（NULL = 未認領／個人信箱忽略）
  - 新檔 `migrations/0004_shared_mailboxes.sql`；以 `wrangler d1 migrations apply` 套到 dev/test→prod（**`wrangler deploy` 不會自動 apply**）
- **API contract**:
  - `POST /send`：req 可帶 `mailboxId`；server 驗證屬「可寄集合」（owned 個人 ∪ 全部共用）；`from` 強制 = `mailbox.address`；從共用信箱開**新對話** → `thread.assignee = sender`；回覆**未認領**共用對話 → 原子認領。
  - `POST /admin/mailboxes`：req 新增可選 `kind`（`'personal'`｜`'shared'`）；`kind='shared'` 時 `ownerEmail` 可空；位址 regex 不變。
  - thread 列表端點 + `GET /api/threads/all`：套可見性過濾（個人 owned=全部；共用=assignee=me OR NULL；admin=共用全部）。
- **架構決策**：做法 A（`mailboxes.kind` + `threads.assignee_id`）。理由：現只 2 人 +「人人可用」，做法 B 權限表幾乎每筆相同且仍需 assignee；A 改動最小、最快上線；未來要團隊權限再升級 B（assignee 欄位可沿用，不白做）。
- **第三方/整合**：寄信沿用 cf-email relay（`src/lib/cfemail.ts`，MailChannels backend）；收信沿用 Cloudflare Email Routing catch-all。DNS／Routing 不需改（catch-all 已涵蓋 `*@movo.com.my`）。
- **安全/權限**：
  - `from` server-forced，client 不可偽造（既有，保留）。
  - 個人信箱僅擁有者可寄；共用信箱任一登入者可寄。
  - `getMailboxesForUser` 維持「只回個人信箱」→ 登入閘門（owns≥1 mailbox）不被共用信箱污染；另開 `getSendableMailboxes`。
  - 可見性：個人信箱嚴格 owner-only（**admin 也看不到別人個人信箱**）；共用信箱 admin 可見全部。
  - 認領原子性：`UPDATE threads SET assignee_id=? WHERE id=? AND assignee_id IS NULL`（first-write-wins）。
- **邊界/效能**：
  - 並發認領 → 原子先到先得；落敗者回信仍寄出，thread 歸先到者（2 人情境極罕見，接受）。
  - 純客服（無個人信箱）未來員工 → 目前 `access.ts`「owns≥1」會擋；Kee/Priss 都有個人信箱故不受影響；本期不擴充。
  - rate limit 沿用既有 per-mailbox 100/hr。

## Testing Decisions

| Module | 要測? | 測什麼外部行為 | Prior art（既有同類測試） |
|---|---|---|---|
| `src/api/send.ts` | ✅ | 任一 user 可寄共用；非擁有者寄別人個人信箱→403；`from` 被強制；寄共用新對話設 assignee=sender | `src/api/*.test.ts`（plan 階段 grep 確認） |
| `src/email/inbound.ts` | ✅ | 共用新信 assignee=NULL；回信命中既有 thread 不改 assignee | `src/email/*.test.ts`（同上） |
| claim（db/send） | ✅ | 回未認領→assignee 變回覆者；並發只一人成功 | — |
| `src/api/scope.ts` 可見性 | ✅ | Priss 看不到 Kee 已認領共用對話；未認領兩人都看到；admin 看共用全部；admin 看不到別人個人信箱 | `src/api/*.test.ts` |
| `src/api/admin.ts` | ✅ | 建 `kind=shared` 可無 owner；個人信箱仍需 owner | `src/api/admin*.test.ts` |
| `Compose.tsx` | 🟡 | `fromOptions` 含共用 + 標記顯示 | `web/src/**/*.test.tsx`（如有） |

## Vertical Slices

### Slice 1 — Schema + 信箱分型 + 供裝
- **Type**: AFK
- **Blocked by**: None
- **User stories**: #13, #14
- **Acceptance criteria**:
  - [ ] migration 0004 加 `mailboxes.kind`、`threads.assignee_id`；dev/test DB apply 成功
  - [ ] `POST /admin/mailboxes` 支援 `kind='shared'` 且 owner 可空；`kind='personal'` 仍需 owner
  - [ ] 既有個人信箱行為無回歸（kind 預設 personal）

### Slice 2 — 共用信箱寄信 + 寄件歸屬
- **Type**: AFK
- **Blocked by**: Slice 1
- **User stories**: #1, #3, #11, #12
- **Acceptance criteria**:
  - [ ] `getSendableMailboxes` = 個人(owned) ∪ 全部共用
  - [ ] 任一 user 可從共用信箱寄信；`from` server-forced
  - [ ] 非擁有者寄別人個人信箱 → 403
  - [ ] 從共用信箱開新對話 → `thread.assignee = 寄信者`

### Slice 3 — 收信歸屬 + 公海 + 回覆即認領
- **Type**: AFK
- **Blocked by**: Slice 2
- **User stories**: #5, #6, #7
- **Acceptance criteria**:
  - [ ] 全新客人寄共用地址（無對應 thread）→ assignee=NULL
  - [ ] 回信命中既有 thread → assignee 不變
  - [ ] 回覆未認領共用對話 → 原子認領 assignee=回覆者
  - [ ] 並發認領 first-write-wins（測試模擬兩請求）

### Slice 4 — 可見性（個人/共用/admin）+ 統一收件匣
- **Type**: AFK
- **Blocked by**: Slice 3
- **User stories**: #4, #8, #9, #10
- **Acceptance criteria**:
  - [ ] 共用信箱列表：user 見 assignee=me OR NULL
  - [ ] Priss 看不到 Kee 已認領的共用對話
  - [ ] `GET /api/threads/all` 含個人全部 + 共用(我的+未認領)
  - [ ] admin 見共用全部（含他人已認領）；admin 看不到別人個人信箱
  - [ ] 個人信箱可見性無回歸

### Slice 5 — 前端：寄件選單 + 共用標記 + 未認領狀態
- **Type**: HITL（視覺確認）
- **Blocked by**: Slice 2, Slice 4
- **User stories**: #1, #2, #8
- **Acceptance criteria**:
  - [ ] Compose `fromOptions` 含全部共用信箱
  - [ ] 共用信箱在選單/清單顯示「共用」標記
  - [ ] 收件匣對未認領共用對話顯示可辨識狀態
  - [ ] 中文字體/行高符合既有規範

## Out of Scope

- 做法 B：`mailbox_members` 細權限/角色表
- 認領後轉手 / 退回公海 / 指派他人
- 獨立「認領」按鈕（v1 只用回覆即認領）
- 純客服（無個人信箱）登入放行擴充
- Admin 讀取**個人信箱**內容（僅開放共用信箱）
- 自動 PR / 自動 merge

## Further Notes

- **Prod D1 migration**：`wrangler deploy` 不會自動 apply D1 migration。0004 須以 `wrangler d1 migrations apply movo-mail-production`（及 dev/test DB）手動執行；deploy 前先在 disposable/test DB 驗。
- Prod worker：`movo-mail-production.acejou27.workers.dev`（acejou27 CF account）；admin seeded out-of-band（`acejou27@gmail.com`、`nelsonjou1101@gmail.com`）。
- `op` CLI 目前未登入（`account is not signed in`）；commit SSH 簽章可用（1P agent 已解鎖）。若任何步驟需 `op` 取 secret 須先 `op signin`。
- 身分模型：World-B（個人 Gmail 登入，`mailbox.owner_id ↔ users.email`）；見 `docs/2026-06-03-uat-pre-onboarding.md`。
- 既有 `threads` 表結構須於 writing-plans 前確認（是否每信箱獨立、assignee 加在 thread 層正確）。
