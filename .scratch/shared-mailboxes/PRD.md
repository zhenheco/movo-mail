Status: ready-for-agent

# PRD: Movo Mail — 共用信箱（Shared Mailboxes）

> 來源 spec：`docs/superpowers/specs/2026-06-12-shared-mailboxes-design.md`
> 做法 A（`mailboxes.kind` + `threads.assignee_id`），非權限表。

## Problem Statement

Kee 和 Priss 想用公司公用地址 `Hello@`／`Customer@`／`Service@movo.com.my` 對外往來，
但 Movo Mail 目前每個信箱只有單一擁有者，使用者只能收發「自己擁有的信箱」。痛點：

1. 三個公用地址沒人能在 Movo Mail 裡拿來寄信。
2. 客人寄到公用地址的信沒有共用收件匣，不知道誰該回。
3. Kee／Priss 各自對外往來會混在一起、或互相看到對方私人信件。

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

## Implementation Decisions

- **做法 A**（`mailboxes.kind` + `threads.assignee_id`）。理由：現只 2 人 +「人人可用」，做法 B 權限表幾乎每筆相同且仍需 assignee；A 改動最小、最快上線；未來要團隊權限再升級 B（assignee 欄位沿用，不白做）。
- **Schema 變更**：
  - `mailboxes` 加 `kind`（`'personal'` 預設 ｜ `'shared'`）。
  - `threads` 加 `assignee_id`（指向 user，可空；NULL = 未認領／個人信箱忽略；user 刪除時設 NULL）。
  - 新 migration `0004`；以 `wrangler d1 migrations apply` 套到 dev/test→prod（`wrangler deploy` 不會自動 apply）。
- **模組**：
  - `migration 0004` — 加上述兩欄（新建）。
  - db 層 — `getSendableMailboxes(user)` = owned 個人 ∪ 全部共用；`claimThread(threadId, userId)` 原子認領；thread 列表查詢套可見性過濾（修改）。
  - send — 寄信權限改用 sendable 集合；`from` server-forced；共用新對話設 assignee=sender；回覆未認領共用對話觸發認領（修改）。
  - inbound — 收信存檔不變；共用新 thread assignee 初值 NULL；回信命中既有 thread 不改 assignee（修改）。
  - scope/可見性 — 個人 owner-only；共用 = assignee=me OR NULL；admin = 共用全部（修改）。
  - admin — 建立信箱支援 `kind=shared`、owner 可空（修改）。
  - 前端 Compose + 信箱清單 — 寄件選單含共用信箱 + 「共用」標記 + 未認領狀態（修改）。
- **API contract**：
  - `POST /send`：req 可帶 `mailboxId`；server 驗證屬 sendable 集合；`from` 強制 = mailbox.address。
  - `POST /admin/mailboxes`：req 新增可選 `kind`；`shared` 時 `ownerEmail` 可空；位址 regex 不變。
  - thread 列表 + `GET /api/threads/all`：套可見性過濾。
- **第三方/整合**：寄信沿用 cf-email relay；收信沿用 CF Email Routing catch-all；DNS/Routing 不需改。
- **安全/權限**：`from` server-forced 不可偽造；個人信箱僅擁有者可寄；`getMailboxesForUser` 維持只回個人信箱（登入閘門不被共用污染）；個人信箱嚴格 owner-only（admin 也看不到別人個人信箱）；認領原子性 `UPDATE ... WHERE assignee_id IS NULL`。
- **邊界/效能**：並發認領先到先得（落敗者信仍寄出）；純客服（無個人信箱）本期不擴充放行；rate limit 沿用 per-mailbox 100/hr。

## Testing Decisions

好測試只測外部可觀察行為，不測實作細節。要測模組：

- **send**：任一 user 可寄共用；非擁有者寄別人個人信箱→403；`from` 被強制；共用新對話設 assignee=sender。
- **inbound**：共用新信 assignee=NULL；回信命中既有 thread 不改 assignee。
- **claim**：回未認領→assignee 變回覆者；並發只一人成功。
- **scope/可見性**：Priss 看不到 Kee 已認領共用對話；未認領兩人都看到；admin 看共用全部；admin 看不到別人個人信箱。
- **admin create**：建 `kind=shared` 可無 owner；個人信箱仍需 owner。
- Prior art：plan 階段 grep 既有 `src/api/*.test.ts`、`src/email/*.test.ts` 對齊測試風格。

## Out of Scope

- 做法 B：`mailbox_members` 細權限/角色表。
- 認領後轉手 / 退回公海 / 指派他人。
- 獨立「認領」按鈕（v1 只用回覆即認領）。
- 純客服（無個人信箱）登入放行擴充。
- Admin 讀取**個人信箱**內容（僅開放共用信箱）。
- 自動 PR / 自動 merge。

## Further Notes

- **Prod D1 migration**：`wrangler deploy` 不自動 apply migration。0004 須手動 `wrangler d1 migrations apply movo-mail-production`（及 dev/test）；deploy 前先在 test DB 驗。
- Prod worker：`movo-mail-production.acejou27.workers.dev`（acejou27 CF account）；admin seeded out-of-band（`acejou27@gmail.com`、`nelsonjou1101@gmail.com`）。
- `op` CLI 目前未登入；commit SSH 簽章可用。需 secret 時先 `op signin`。
- 既有 `threads` 表結構須於 writing-plans 前確認（assignee 加在 thread 層正確）。
